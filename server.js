require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const yocoSecretKey = process.env.YOCO_SECRET_KEY || 'sk_test_8392138217392138';
const supabase = createClient(supabaseUrl, supabaseKey);

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const cleanStr = timeStr.trim();
    if (cleanStr.includes('AM') || cleanStr.includes('PM')) {
        const parts = cleanStr.split(' ');
        const timeParts = parts[0].split(':');
        let hours = Number(timeParts[0]) % 12;
        if (parts[1] === 'PM') hours += 12;
        return hours * 60 + (Number(timeParts[1]) || 0);
    }
    const [h, m] = cleanStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

function convertSlotToRange(slot, startTime, durationHours) {
    if (startTime && durationHours) {
        const startMin = parseTimeToMinutes(startTime);
        return { startMin, endMin: startMin + (parseFloat(durationHours) * 60) };
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

function escapeCSV(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
}

// ==========================================
// PUBLIC & CLIENT API ROUTES
// ==========================================

app.get('/api/tables', async (req, res) => {
    const { data, error } = await supabase.from('pool_tables').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

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

// YOCO PAYMENTS ROUTE
app.post('/api/bookings/multi-pay', async (req, res) => {
    const { token, tableIds, date, startTime, durationHours, slot, userName, phone, userId, bookingFeePerTable } = req.body;

    if (!token) {
        return res.status(400).json({ error: 'Missing payment token.' });
    }

    if (!tableIds || !Array.isArray(tableIds) || tableIds.length === 0) {
        return res.status(400).json({ error: 'Please select at least one table.' });
    }

    const targetRange = convertSlotToRange(slot, startTime, durationHours);

    // 1. Conflict Check before charging card
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
            return res.status(409).json({ error: `Table ${tableId} is no longer available.` });
        }
    }

    // 2. Calculate Total Amount
    const { data: dbTables } = await supabase.from('pool_tables').select('id, price');
    const priceMap = {};
    (dbTables || []).forEach(t => priceMap[t.id] = Number(t.price) || 50);

    const fee = Number(bookingFeePerTable) || 15;
    const duration = Number(durationHours) || 1;

    let totalAmountRands = 0;
    tableIds.forEach(tableId => {
        const basePrice = priceMap[tableId] || 50;
        totalAmountRands += (basePrice * duration) + fee;
    });

    const amountInCents = Math.round(totalAmountRands * 100);

    // 3. Process Charge via Yoco API
    try {
        const yocoResponse = await fetch('https://online.yoco.com/v1/charges/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Secret-Key': yocoSecretKey
            },
            body: JSON.stringify({
                token: token,
                amountInCents: amountInCents,
                currency: 'ZAR'
            })
        });

        const chargeResult = await yocoResponse.json();

        if (!yocoResponse.ok || chargeResult.status !== 'successful') {
            return res.status(400).json({ 
                error: chargeResult.errorMessage || 'Yoco payment transaction failed.' 
            });
        }

        // 4. Save confirmed bookings to database
        const rows = tableIds.map(tableId => {
            const basePrice = priceMap[tableId] || 50;
            const subtotal = basePrice * duration;
            return {
                ref_id: `YOC-${Math.floor(100000 + Math.random() * 900000)}`,
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
                status: 'CONFIRMED',
                payment_status: 'PAID_ONLINE',
                payment_method: 'YOCO',
                is_active: true
            };
        });

        const { data, error } = await supabase.from('bookings').insert(rows).select();
        if (error) return res.status(500).json({ error: error.message });

        res.status(201).json({ success: true, count: data.length, chargeId: chargeResult.id, bookings: data });

    } catch (err) {
        console.error('Yoco Execution Error:', err);
        res.status(500).json({ error: 'Internal payment gateway error.' });
    }
});

// MULTI-TABLE USER BOOKINGS (PAY AT COUNTER ROUTE)
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
            return res.status(409).json({ error: `Table ${tableId} is no longer available.` });
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
            status: 'CONFIRMED',
            payment_status: 'DIRECT',
            is_active: true
        };
    });

    const { data, error } = await supabase.from('bookings').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({ success: true, count: data.length, bookings: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CueCraft Server running on port ${PORT}`));
