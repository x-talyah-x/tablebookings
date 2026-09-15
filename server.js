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

// 1. GET ALL POOL TABLES
app.get('/api/tables', async (req, res) => {
    const { data, error } = await supabase.from('pool_tables').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// 2. GET AVAILABLE TABLES BY TIME SLOT OVERLAP
app.get('/api/tables/available', async (req, res) => {
    const { date, startTime, duration, slot } = req.query;

    if (!date || (!slot && (!startTime || !duration))) {
        return res.status(400).json({ error: 'Date and valid time details are required.' });
    }

    try {
        const requestRange = convertSlotToRange(slot, startTime, duration);

        const { data: tables, error: tablesError } = await supabase.from('pool_tables').select('*').order('id');
        if (tablesError) throw tablesError;

        const { data: bookings, error: bookingsError } = await supabase
            .from('bookings')
            .select('*')
            .eq('booking_date', date)
            .eq('is_active', true);
        if (bookingsError) throw bookingsError;

        const availableTables = tables.filter(table => {
            const tableBookings = bookings.filter(b => b.table_id === table.id);
            const hasConflict = tableBookings.some(booking => {
                const existingRange = convertSlotToRange(booking.time_slot, booking.start_time, booking.duration_hours);
                return doSlotsOverlap(requestRange, existingRange);
            });
            return !hasConflict;
        });

        res.json(availableTables);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. GET BOOKINGS BY DATE AND SLOT
app.get('/api/bookings', async (req, res) => {
    const { date, slot } = req.query;
    let query = supabase.from('bookings').select('*').eq('is_active', true);
    
    if (date) query = query.eq('booking_date', date);
    if (slot) query = query.eq('time_slot', slot);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 4. CREATE DIRECT CLIENT BOOKING
app.post('/api/bookings', async (req, res) => {
    const { tableId, date, startTime, durationHours, slot, userName, phone, userId, bookingFee, totalPrice } = req.body;
    const requestRange = convertSlotToRange(slot, startTime, durationHours);

    const { data: existingBookings, error: fetchErr } = await supabase
        .from('bookings')
        .select('*')
        .eq('table_id', tableId)
        .eq('booking_date', date)
        .eq('is_active', true);

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });

    const hasConflict = (existingBookings || []).some(b => {
        const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
        return doSlotsOverlap(requestRange, existingRange);
    });

    if (hasConflict) {
        return res.status(409).json({ error: 'Table is already reserved for this time slot.' });
    }

    const refId = 'REF-' + Math.floor(1000 + Math.random() * 9000);

    const { data, error } = await supabase.from('bookings').insert([{
        ref_id: refId,
        table_id: tableId,
        booking_date: date,
        time_slot: slot,
        user_name: userName,
        phone,
        booking_fee: bookingFee || 15,
        total_price: totalPrice,
        status: 'CONFIRMED',
        payment_status: 'UNPAID',
        user_identifier: userId,
        is_active: true
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// 5. ADMIN ACTION ITEMS (WITH OVERLAP CONFLICT CHECK)
app.post('/api/admin/action-item', async (req, res) => {
    const { actionType, paymentMethod, tables, slots, date, durationHours } = req.body;

    if (!tables || !slots || tables.length === 0 || slots.length === 0) {
        return res.status(400).json({ error: 'Tables and slots are required.' });
    }

    try {
        const tableIds = tables.map(Number);

        // CLEAR TABLES ACTION: Perform Soft Delete (is_active = false)
        if (actionType === 'CLEAR_TABLE') {
            const { error: softDeleteErr } = await supabase
                .from('bookings')
                .update({ is_active: false })
                .eq('booking_date', date)
                .in('table_id', tableIds);

            if (softDeleteErr) throw softDeleteErr;
            return res.json({ success: true, message: 'Bookings soft-deleted for specified tables and date.' });
        }

        // 1. CHECK FOR OVERLAPPING ACTIVE BOOKINGS
        const { data: existingBookings, error: fetchErr } = await supabase
            .from('bookings')
            .select('*')
            .eq('booking_date', date)
            .in('table_id', tableIds)
            .eq('is_active', true);

        if (fetchErr) throw fetchErr;

        // Verify each requested slot against all existing active bookings on target tables
        for (const tableId of tableIds) {
            const tableBookings = (existingBookings || []).filter(b => Number(b.table_id) === Number(tableId));
            
            for (const slot of slots) {
                const requestRange = convertSlotToRange(slot, null, durationHours);

                const conflict = tableBookings.find(b => {
                    const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
                    return doSlotsOverlap(requestRange, existingRange);
                });

                if (conflict) {
                    return res.status(409).json({ 
                        error: `Table ${tableId} is already booked for time slot (${conflict.time_slot}) by ${conflict.user_name}. Clear or trim existing bookings first.` 
                    });
                }
            }
        }

        // 2. RETRIEVE DEFAULT POOL TABLE PRICING
        const { data: dbTables, error: tableError } = await supabase
            .from('pool_tables')
            .select('id, price');

        if (tableError) throw tableError;

        const tablePriceMap = {};
        (dbTables || []).forEach(t => { tablePriceMap[t.id] = Number(t.price) || 60.00; });

        const duration = Number(durationHours) || 1;
        const insertRows = [];

        // 3. BUILD INSERT PAYLOAD
        tables.forEach(tableId => {
            const numericTableId = Number(tableId);
            const tableRate = tablePriceMap[numericTableId] || 60.00;
            const isLeague = actionType === 'RESERVED';
            
            let calculatedPrice = 0.00;
            if (isLeague || actionType === 'WALK_IN') {
                calculatedPrice = tableRate * duration;
            }

            slots.forEach(slot => {
                const refPrefix = actionType === 'WALK_IN' ? 'WALK' : (actionType === 'MAINTENANCE' ? 'MNT' : 'LEAGUE');
                const refId = `${refPrefix}-${Math.floor(1000 + Math.random() * 9000)}`;
                
                let userName = 'LEAGUE RESERVATION';
                if (actionType === 'WALK_IN') userName = 'WALK IN';
                else if (actionType === 'MAINTENANCE') userName = 'SYSTEM MAINTENANCE';

                insertRows.push({
                    ref_id: refId,
                    table_id: numericTableId,
                    booking_date: date,
                    time_slot: slot,
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
        });

        // 4. EXECUTE INSERT
        const { data, error } = await supabase.from('bookings').insert(insertRows).select();
        if (error) throw error;

        res.status(201).json({ success: true, count: data.length, records: data });
    } catch (err) {
        console.error('Supabase Action Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 6. GET DAY BOOKINGS FOR ADMIN TIMELINE
app.get('/api/admin/day-bookings', async (req, res) => {
    const { date } = req.query;
    const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date)
        .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });
    
    const mapped = (data || []).map(b => ({
        ...b,
        date: b.booking_date,
        slot: b.time_slot
    }));
    
    res.json(mapped);
});

// HELPER: Calculates the exact start and end date strings for any given YYYY-MM
function getMonthDateRange(yearMonth) {
    const [year, month] = yearMonth.split('-').map(Number);
    // Setting day 0 of the NEXT month gives the exact last day of the TARGET month
    const lastDay = new Date(year, month, 0).getDate();
    
    return {
        startDate: `${yearMonth}-01`,
        endDate: `${yearMonth}-${String(lastDay).padStart(2, '0')}`
    };
}

// 7. EXPORT MONTHLY BOOKINGS CSV
app.get('/api/admin/export-month-csv', async (req, res) => {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Month parameter is required (YYYY-MM).' });

    const { startDate, endDate } = getMonthDateRange(month);

    const { data, error } = await supabase
        .from('bookings')
        .select('ref_id, booking_date, time_slot, table_id, user_name, total_price, payment_method, payment_status, status')
        .gte('booking_date', startDate)
        .lte('booking_date', endDate)
      
    if (error) return res.status(500).json({ error: error.message });

    const headers = ['Ref ID', 'Date', 'Time Slot', 'Table ID', 'User Name', 'Total Price', 'Payment Method', 'Payment Status', 'Status'];
    
    const csvRows = [
        headers.join(','),
        ...(data || []).map(row => [
            `"${row.ref_id || ''}"`,
            `"${row.booking_date || ''}"`,
            `"${row.time_slot || ''}"`,
            `"${row.table_id || ''}"`,
            `"${(row.user_name || '').replace(/"/g, '""')}"`,
            `"${row.total_price || 0}"`,
            `"${row.payment_method || ''}"`,
            `"${row.payment_status || ''}"`,
            `"${row.status || ''}"`
        ].join(','))
    ];

    res.header('Content-Type', 'text/csv');
    res.attachment(`bookings-${month}.csv`);
    return res.send(csvRows.join('\n'));
});

// 8. MONTHLY FINANCIAL SUMMARY CALCULATIONS
app.get('/api/admin/month-summary', async (req, res) => {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Month parameter is required (YYYY-MM).' });

    const { startDate, endDate } = getMonthDateRange(month);

    const { data: bookings, error } = await supabase
        .from('bookings')
        .select('*')
        .gte('booking_date', startDate)
        .lte('booking_date', endDate)

    if (error) return res.status(500).json({ error: error.message });

    let totalRevenue = 0;
    let totalCash = 0;
    let totalCard = 0;
    const days = {};

    (bookings || []).forEach(b => {
        const price = Number(b.total_price) || 0;
        totalRevenue += price;

        if (b.payment_method === 'CASH') totalCash += price;
        if (b.payment_method === 'CARD') totalCard += price;

        if (!days[b.booking_date]) {
            days[b.booking_date] = { total: 0, cash: 0, card: 0, count: 0 };
        }
        days[b.booking_date].total += price;
        if (b.payment_method === 'CASH') days[b.booking_date].cash += price;
        if (b.payment_method === 'CARD') days[b.booking_date].card += price;
        days[b.booking_date].count += 1;
    });

    res.json({ totalRevenue, totalCash, totalCard, days });
});

// 8. MONTHLY FINANCIAL SUMMARY CALCULATIONS
app.get('/api/admin/month-summary', async (req, res) => {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Month parameter is required (YYYY-MM).' });

    const startDate = `${month}-01`;
    const endDate = `${month}-31`;

    const { data: bookings, error } = await supabase
        .from('bookings')
        .select('*')
        .gte('booking_date', startDate)
        .lte('booking_date', endDate)
        .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });

    let totalRevenue = 0;
    let totalCash = 0;
    let totalCard = 0;
    const days = {};

    (bookings || []).forEach(b => {
        const price = Number(b.total_price) || 0;
        totalRevenue += price;

        if (b.payment_method === 'CASH') totalCash += price;
        if (b.payment_method === 'CARD') totalCard += price;

        if (!days[b.booking_date]) {
            days[b.booking_date] = { total: 0, cash: 0, card: 0, count: 0 };
        }
        days[b.booking_date].total += price;
        if (b.payment_method === 'CASH') days[b.booking_date].cash += price;
        if (b.payment_method === 'CARD') days[b.booking_date].card += price;
        days[b.booking_date].count += 1;
    });

    res.json({ totalRevenue, totalCash, totalCard, days });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CueCraft Server running on port ${PORT}`));