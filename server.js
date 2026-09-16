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

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_your_paystack_secret_key';

// Helper: Parse standard time strings ("14:00", "02:00 PM") into minutes from midnight
function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const cleanStr = timeStr.trim();
    if (cleanStr.includes('AM') || cleanStr.includes('PM')) {
        const parts = cleanStr.split(' ');
        const [h, m] = parts[0].split(':').map(Number);
        let hours = h % 12;
        if (parts[1] === 'PM') hours += 12;
        return hours * 60 + (m || 0);
    }
    const [h, m] = cleanStr.split(':').map(Number);
    return h * 60 + (m || 0);
}

// Helper: Convert time slots or (startTime + duration) into start/end minute windows
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

// Helper: Check minute boundary overlaps between time windows
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

// 2. GET AVAILABLE TABLES FOR A SPECIFIC TIME SLOT
app.get('/api/tables/available', async (req, res) => {
    const { date, startTime, duration } = req.query;

    const { data: tables, error: tablesErr } = await supabase.from('pool_tables').select('*').order('id');
    if (tablesErr) return res.status(500).json({ error: tablesErr.message });

    const { data: activeBookings, error: bookingsErr } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date)
        .eq('is_active', true);

    if (bookingsErr) return res.status(500).json({ error: bookingsErr.message });

    const targetRange = convertSlotToRange(null, startTime, duration);

    const availableTables = (tables || []).filter(t => {
        const tableBookings = activeBookings.filter(b => Number(b.table_id) === Number(t.id));
        const hasConflict = tableBookings.some(b => {
            const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
            return doSlotsOverlap(targetRange, existingRange);
        });
        return !hasConflict;
    });

    res.json(availableTables);
});

// 3. WEEKLY AVAILABILITY GRID MATRIX
app.get('/api/weekly-availability', async (req, res) => {
    const { startDate } = req.query;
    if (!startDate) return res.status(400).json({ error: 'startDate parameter required (YYYY-MM-DD)' });

    const dates = [];
    const baseDate = new Date(startDate);
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }

    const { data: tables, error: tableErr } = await supabase.from('pool_tables').select('id');
    if (tableErr) return res.status(500).json({ error: tableErr.message });
    const totalTablesCount = tables ? tables.length : 22;

    const { data: bookings, error: bookingsErr } = await supabase
        .from('bookings')
        .select('*')
        .in('booking_date', dates)
        .eq('is_active', true);

    if (bookingsErr) return res.status(500).json({ error: bookingsErr.message });

    const result = {};
    const hours = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

    dates.forEach(d => {
        result[d] = {};
        const dayBookings = (bookings || []).filter(b => b.booking_date === d);

        hours.forEach(hour => {
            const slotRange = { startMin: hour * 60, endMin: (hour + 1) * 60 };
            const bookedTableIds = new Set();

            dayBookings.forEach(b => {
                const bRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
                if (doSlotsOverlap(slotRange, bRange)) {
                    bookedTableIds.add(Number(b.table_id));
                }
            });

            const available = Math.max(0, totalTablesCount - bookedTableIds.size);
            result[d][hour] = { available, total: totalTablesCount };
        });
    });

    res.json(result);
});

// 4. MULTI-TABLE USER BOOKINGS
app.post('/api/bookings/multi', async (req, res) => {
    const { tableIds, date, startTime, durationHours, slot, userName, phone, userId, bookingFeePerTable } = req.body;

    if (!tableIds || !Array.isArray(tableIds) || tableIds.length === 0) {
        return res.status(400).json({ error: 'Please select at least one table.' });
    }

    const targetRange = convertSlotToRange(slot, startTime, durationHours);

    const { data: activeBookings, error: fetchErr } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date)
        .in('table_id', tableIds)
        .eq('is_active', true);

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });

    for (const tableId of tableIds) {
        const conflict = (activeBookings || []).find(b => {
            if (Number(b.table_id) !== Number(tableId)) return false;
            const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
            return doSlotsOverlap(targetRange, existingRange);
        });

        if (conflict) {
            return res.status(409).json({ error: `Table ${tableId} is no longer available for the selected slot.` });
        }
    }

    const { data: dbTables } = await supabase.from('pool_tables').select('id, price');
    const priceMap = {};
    (dbTables || []).forEach(t => priceMap[t.id] = Number(t.price) || 50);

    const fee = Number(bookingFeePerTable) || 15;
    const duration = Number(durationHours) || 1;

    const rows = tableIds.map(tableId => {
        const basePrice = priceMap[tableId] || 50;
        const subtotal = basePrice * duration;
        return {
            ref_id: `CUE-${Math.floor(100000 + Math.random() * 900000)}`,
            table_id: Number(tableId),
            booking_date: date,
            start_time: startTime,
            duration_hours: duration,
            time_slot: slot,
            user_name: userName,
            phone: phone,
            user_identifier: userId,
            booking_fee: fee,
            total_price: subtotal + fee,
            status: 'PENDING',
            payment_status: 'PENDING',
            is_active: true
        };
    });

    const { data, error } = await supabase.from('bookings').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({ success: true, count: data.length, bookings: data });
});

// 5. GET DAY BOOKINGS & DAILY FINANCIAL TOTALS FOR ADMIN
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

// 6. ADMIN ACTION ITEMS (WALK-IN, MAINTENANCE, RESERVED, & CLEAR)
app.post('/api/admin/action-item', async (req, res) => {
    const { actionType, paymentMethod, tables, slots, date, durationHours, startTimeOverride } = req.body;

    if (!tables || tables.length === 0) {
        return res.status(400).json({ error: 'Tables are required.' });
    }

    try {
        const tableIds = tables.map(Number);
        let computedSlot = slots ? slots[0] : null;
        let requestRange = null;

        if (actionType === 'CLEAR_TABLE') {
            const now = new Date();
            const startMin = startTimeOverride ? parseTimeToMinutes(startTimeOverride) : (now.getHours() * 60 + now.getMinutes());
            requestRange = { startMin, endMin: startMin + 60 };

            const { data: existingBookings, error: fetchErr } = await supabase
                .from('bookings')
                .select('*')
                .eq('booking_date', date)
                .in('table_id', tableIds)
                .eq('is_active', true);

            if (fetchErr) throw fetchErr;

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

        if (computedSlot) {
            requestRange = convertSlotToRange(computedSlot, startTimeOverride, durationHours);
        }

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
                start_time: startTimeOverride || null,
                duration_hours: duration,
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

// 7. EXPORT MONTHLY CSV
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

// 8. MONTHLY SUMMARY
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

// 9. INITIALIZE PAYSTACK TRANSACTION
app.post('/api/bookings/initialize-payment', async (req, res) => {
    try {
        const { tableIds, date, startTime, durationHours, slot, userName, email, phone, totalPrice } = req.body;

        if (!tableIds || !Array.isArray(tableIds) || tableIds.length === 0) {
            return res.status(400).json({ error: 'Please select at least one table.' });
        }

        const targetRange = convertSlotToRange(slot, startTime, durationHours);

        const { data: activeBookings, error: fetchErr } = await supabase
            .from('bookings')
            .select('*')
            .eq('booking_date', date)
            .in('table_id', tableIds)
            .eq('is_active', true);

        if (fetchErr) return res.status(500).json({ error: fetchErr.message });

        for (const tableId of tableIds) {
            const conflict = (activeBookings || []).find(b => {
                if (Number(b.table_id) !== Number(tableId)) return false;
                const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
                return doSlotsOverlap(targetRange, existingRange);
            });

            if (conflict) {
                return res.status(409).json({ error: `Table ${tableId} is no longer available for the selected slot.` });
            }
        }

        const amountInCents = Math.round(parseFloat(totalPrice) * 100);

        const paystackPayload = {
            email: email || `${phone.replace(/\D/g, '')}@cuecraft.com`,
            amount: amountInCents,
            currency: 'ZAR',
            callback_url: `${req.protocol}://${req.get('host')}/payment-success.html`,
            metadata: { tableIds, date, startTime, durationHours, slot, userName, phone }
        };

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(paystackPayload)
        });

        const paystackData = await response.json();

        if (!paystackData.status) {
            return res.status(400).json({ error: paystackData.message || 'Payment initialization failed.' });
        }

        res.json({
            authorization_url: paystackData.data.authorization_url,
            reference: paystackData.data.reference
        });
    } catch (err) {
        console.error('Paystack initialization error:', err);
        res.status(500).json({ error: 'Internal server error while initializing payment.' });
    }
});

// 10. VERIFY PAYSTACK PAYMENT & PERSIST BOOKINGS
app.post('/api/bookings/verify-payment', async (req, res) => {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Transaction reference is required.' });

    try {
        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const paystackData = await response.json();

        if (!paystackData.status || paystackData.data.status !== 'success') {
            return res.status(400).json({ error: 'Payment verification failed or transaction incomplete.' });
        }

        const data = paystackData.data;
        const meta = data.metadata;
        const { tableIds, date, startTime, durationHours, slot, userName, phone } = meta;

        const { data: existing } = await supabase
            .from('bookings')
            .select('id')
            .eq('ref_id', reference);

        if (existing && existing.length > 0) {
            return res.json({ success: true, message: 'Reservation already confirmed.' });
        }

        const { data: dbTables } = await supabase.from('pool_tables').select('id, price');
        const priceMap = {};
        (dbTables || []).forEach(t => priceMap[t.id] = Number(t.price) || 50);

        const fee = 15;
        const duration = Number(durationHours) || 1;

        const rows = tableIds.map(tableId => {
            const basePrice = priceMap[tableId] || 50;
            const subtotal = basePrice * duration;
            return {
                ref_id: reference,
                table_id: Number(tableId),
                booking_date: date,
                start_time: startTime,
                duration_hours: duration,
                time_slot: slot,
                user_name: userName,
                phone: phone,
                user_identifier: 'ONLINE_PAYSTACK',
                booking_fee: fee,
                total_price: subtotal + fee,
                status: 'RESERVED',
                payment_status: 'PAID',
                payment_method: 'CARD',
                is_active: true
            };
        });

        const { data: inserted, error } = await supabase.from('bookings').insert(rows).select();
        if (error) return res.status(500).json({ error: error.message });

        res.status(201).json({ success: true, count: inserted.length, bookings: inserted });
    } catch (err) {
        console.error('Paystack verification error:', err);
        res.status(500).json({ error: 'Internal server error while verifying payment.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CueCraft Server running on port ${PORT}`));
