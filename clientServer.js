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

// Parse standard 24h or 12h time strings into total minutes from midnight
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

// Convert slot strings or start_time/duration parameters into minute ranges for boundary checking
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

// Determine slot overlap logic using strict minute boundaries
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

// 2. GET AVAILABLE TABLES FOR A SPECIFIC HOURLY TIME SLOT AND DURATION
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

// 3. WEEKLY AVAILABILITY MATRIX
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

// 5. INITIALIZE PAYSTACK TRANSACTION FOR MULTI-TABLE BOOKING
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CueCraft Server running on port ${PORT}`));
