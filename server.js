require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const cleanStr = timeStr.trim();
    if (cleanStr.includes('AM') || cleanStr.includes('PM')) {
        const parts = cleanStr.split(' ');
        const [h, m] = parts[0].split(':').map(Number);
        let hours = h % 12;
        if (parts[1] === 'PM') hours += 12;
        return hours * 60 + m;
    }
    const [h, m] = cleanStr.split(':').map(Number);
    return h * 60 + m;
}

function convertSlotToRange(slot, startTime, durationHours) {
    if (startTime && durationHours) {
        const startMin = parseTimeToMinutes(startTime);
        return { startMin, endMin: startMin + (parseInt(durationHours) * 60) };
    }
    if (slot && slot.includes('-')) {
        const [startStr, endStr] = slot.split('-').map(s => s.trim());
        const startMin = parseTimeToMinutes(startStr);
        let endMin = parseTimeToMinutes(endStr);
        if (endMin <= startMin) endMin += 1440;
        return { startMin, endMin };
    }
    return null;
}

function doSlotsOverlap(rangeA, rangeB) {
    if (!rangeA || !rangeB) return false;
    return Math.max(rangeA.startMin, rangeB.startMin) < Math.min(rangeA.endMin, rangeB.endMin);
}

function getMonthDateRange(yearMonth) {
    const [year, month] = yearMonth.split('-').map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    return {
        startDate: `${yearMonth}-01`,
        endDate: `${yearMonth}-${String(lastDay).padStart(2, '0')}`
    };
}

// 1. GET ALL POOL TABLES
app.get('/api/tables', async (req, res) => {
    const { data, error } = await supabase.from('pool_tables').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// 2. GET DAY BOOKINGS & DAILY FINANCIAL TOTALS FOR ADMIN
app.get('/api/admin/day-bookings', async (req, res) => {
    const { date } = req.query;

    const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date);

    if (error) return res.status(500).json({ error: error.message });

    let totalCash = 0;
    let totalCard = 0;

    const mapped = (data || []).map(b => {
        const price = Number(b.total_price) || 0;
        if (b.payment_method === 'CASH') totalCash += price;
        if (b.payment_method === 'CARD') totalCard += price;
        return { ...b, date: b.booking_date, slot: b.time_slot };
    });

    res.json({
        bookings: mapped,
        summary: { totalCash, totalCard, grandTotal: totalCash + totalCard }
    });
});

// 3. ADMIN ACTION ITEMS (WALK-IN, MAINTENANCE, LEAGUE, & CLEAR)
app.post('/api/admin/action-item', async (req, res) => {
    const { actionType, paymentMethod, tables, slots, date, durationHours, startTimeOverride } = req.body;

    if (!tables || tables.length === 0) {
        return res.status(400).json({ error: 'Tables are required.' });
    }

    try {
        const tableIds = tables.map(Number);
        
        // Calculate Target Time Window
        let computedSlot = slots ? slots[0] : null;
        let requestRange = null;

        if (actionType === 'CLEAR_TABLE') {
            // Target specific slot if passed, or default to current hour block
            const now = new Date();
            const startMin = startTimeOverride ? parseTimeToMinutes(startTimeOverride) : (now.getHours() * 60 + now.getMinutes());
            requestRange = { startMin, endMin: startMin + 60 }; // Target 1-hour slot window

            const { data: existingBookings, error: fetchErr } = await supabase
                .from('bookings')
                .select('*')
                .eq('booking_date', date)
                .in('table_id', tableIds)
                .eq('is_active', true);

            if (fetchErr) throw fetchErr;

            // Only clear bookings that overlap with this target time range
            const bookingIdsToDeactivate = (existingBookings || [])
                .filter(b => {
                    const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
                    return doSlotsOverlap(requestRange, existingRange);
                })
                .map(b => b.id);

            if (bookingIdsToDeactivate.length > 0) {
                const { error: clearErr } = await supabase
                    .from('bookings')
                    .update({ is_active: false })
                    .in('id', bookingIdsToDeactivate);

                if (clearErr) throw clearErr;
            }

            return res.json({ success: true, message: `Cleared target slot for table(s).` });
        }

        // Handle computed range for WALK_IN, MAINTENANCE, RESERVED
        if (computedSlot) {
            requestRange = convertSlotToRange(computedSlot, null, durationHours);
        }

        // Check for conflicting active bookings
        const { data: existingBookings, error: fetchErr } = await supabase
            .from('bookings')
            .select('*')
            .eq('booking_date', date)
            .in('table_id', tableIds)
            .eq('is_active', true);

        if (fetchErr) throw fetchErr;

        for (const tableId of tableIds) {
            const tableBookings = (existingBookings || []).filter(b => Number(b.table_id) === Number(tableId));
            const conflict = tableBookings.find(b => {
                const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
                return doSlotsOverlap(requestRange, existingRange);
            });

            if (conflict) {
                return res.status(409).json({ 
                    error: `Table ${tableId} is already booked for (${conflict.time_slot}) by ${conflict.user_name}. Clear the target slot first.` 
                });
            }
        }

        // Retrieve pricing table
        const { data: dbTables, error: tableError } = await supabase.from('pool_tables').select('id, price');
        if (tableError) throw tableError;

        const tablePriceMap = {};
        (dbTables || []).forEach(t => { tablePriceMap[t.id] = Number(t.price) || 60.00; });

        const duration = Number(durationHours) || 1;
        const insertRows = [];

        tables.forEach(tableId => {
            const numericTableId = Number(tableId);
            const tableRate = tablePriceMap[numericTableId] || 60.00;
            const isLeague = actionType === 'RESERVED';
            
            let calculatedPrice = 0.00;
            if (isLeague || actionType === 'WALK_IN') {
                calculatedPrice = tableRate * duration;
            }

            const refPrefix = actionType === 'WALK_IN' ? 'WALK' : (actionType === 'MAINTENANCE' ? 'MNT' : 'LEAGUE');
            const refId = `${refPrefix}-${Math.floor(1000 + Math.random() * 9000)}`;
            
            let userName = 'LEAGUE RESERVATION';
            if (actionType === 'WALK_IN') userName = 'WALK IN';
            else if (actionType === 'MAINTENANCE') userName = 'SYSTEM MAINTENANCE';

            insertRows.push({
                ref_id: refId,
                table_id: numericTableId,
                booking_date: date,
                time_slot: computedSlot,
                user_name: userName,
                phone: 'N/A',
                booking_fee: 0.00,
                total_price: calculatedPrice,
                status: actionType,
                payment_status: actionType === 'WALK_IN' ? 'PAID' : (isLeague ? 'CONFIRMED' : 'NO_PAYMENT_REQUIRED'),
                payment_method: paymentMethod || null,
                user_identifier: 'ADMIN',
                is_active: true
            });
        });

        const { data, error } = await supabase.from('bookings').insert(insertRows).select();
        if (error) throw error;

        res.status(201).json({ success: true, count: data.length, records: data });
    } catch (err) {
        console.error('Supabase Action Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4. EXPORT MONTHLY CSV
app.get('/api/admin/export-month-csv', async (req, res) => {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Month parameter is required (YYYY-MM).' });

    const { startDate, endDate } = getMonthDateRange(month);

    const { data, error } = await supabase
        .from('bookings')
        .select('ref_id, booking_date, time_slot, table_id, user_name, total_price, payment_method, payment_status, status')
        .gte('booking_date', startDate)
        .lte('booking_date', endDate);
      
    if (error) return res.status(500).json({ error: error.message });

    const headers = ['Ref ID', 'Date', 'Time Slot', 'Table ID', 'User Name', 'Total Price', 'Payment Method', 'Payment Status', 'Status'];
    const csvRows = [
        headers.join(','),
        ...(data || []).map(row => [
            `"${row.ref_id || ''}"`, `"${row.booking_date || ''}"`, `"${row.time_slot || ''}"`,
            `"${row.table_id || ''}"`, `"${(row.user_name || '').replace(/"/g, '""')}"`,
            `"${row.total_price || 0}"`, `"${row.payment_method || ''}"`, `"${row.payment_status || ''}"`, `"${row.status || ''}"`
        ].join(','))
    ];

    res.header('Content-Type', 'text/csv');
    res.attachment(`bookings-${month}.csv`);
    return res.send(csvRows.join('\n'));
});

// 5. MONTHLY SUMMARY
app.get('/api/admin/month-summary', async (req, res) => {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Month parameter is required (YYYY-MM).' });

    const { startDate, endDate } = getMonthDateRange(month);

    const { data: bookings, error } = await supabase
        .from('bookings')
        .select('*')
        .gte('booking_date', startDate)
        .lte('booking_date', endDate)
        .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });

    let totalRevenue = 0, totalCash = 0, totalCard = 0;
    const days = {};

    (bookings || []).forEach(b => {
        const price = Number(b.total_price) || 0;
        totalRevenue += price;
        if (b.payment_method === 'CASH') totalCash += price;
        if (b.payment_method === 'CARD') totalCard += price;

        if (!days[b.booking_date]) days[b.booking_date] = { total: 0, cash: 0, card: 0, count: 0 };
        days[b.booking_date].total += price;
        if (b.payment_method === 'CASH') days[b.booking_date].cash += price;
        if (b.payment_method === 'CARD') days[b.booking_date].card += price;
        days[b.booking_date].count += 1;
    });

    res.json({ totalRevenue, totalCash, totalCard, days });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CueCraft Server running on port ${PORT}`));
