require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY;

// Explicit route for admin dashboard page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Parse standard 24h or 12h time strings into total minutes from midnight
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

// Helper to escape CSV values
function escapeCSV(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
}

// Helper to write bookings array directly to Supabase via Upsert
async function recordBookingsFromMetadata(meta, checkoutOrPaymentId) {
    let tableIds = meta.tableIds;
    if (typeof tableIds === 'string') {
        try {
            tableIds = JSON.parse(tableIds);
        } catch (e) {
            tableIds = [];
        }
    }

    if (!tableIds || !Array.isArray(tableIds) || tableIds.length === 0) {
        return { success: false, reason: 'No table IDs found in metadata.' };
    }

    let formattedStartTime = meta.startTime || '12:00:00';
    if (formattedStartTime.length === 5) {
        formattedStartTime += ':00';
    }

    const yocoIdShort = checkoutOrPaymentId ? String(checkoutOrPaymentId).slice(-8) : Math.floor(100000 + Math.random() * 900000);
    const baseRefId = `YOC-${yocoIdShort}`;

    const bookingFeePerTable = Number(meta.bookingFee || 15) / tableIds.length;
    const totalPricePerTable = Number(meta.totalPrice || 0) / tableIds.length;

    const rows = tableIds.map((tableId, idx) => ({
        ref_id: tableIds.length > 1 ? `${baseRefId}-${idx + 1}`.slice(0, 20) : baseRefId.slice(0, 20),
        table_id: Number(tableId),
        booking_date: meta.date,
        start_time: formattedStartTime,
        duration_hours: Number(meta.durationHours || 1),
        time_slot: meta.slot || `${meta.startTime} - Slot`,
        user_name: meta.userName || 'Online Customer',
        phone: meta.phone || 'N/A',
        user_identifier: meta.userId || 'GUEST',
        booking_fee: bookingFeePerTable,
        total_price: totalPricePerTable,
        status: 'CONFIRMED',
        payment_status: 'PAID',
        payment_method: 'CARD',
        is_active: true
    }));

    const { data, error } = await supabase
        .from('bookings')
        .upsert(rows, { onConflict: 'ref_id' })
        .select();

    if (error) {
        console.error('Supabase Upsert Error:', error);
        throw error;
    }

    return { success: true, data };
}

// ==========================================
// YOCO PAYMENT INTEGRATION ROUTES
// ==========================================

// 1. INITIALIZE YOCO CHECKOUT SESSION
app.post('/api/payments/initialize', async (req, res) => {
    const { tableIds, date, startTime, durationHours, slot, userName, phone, userId } = req.body;

    if (!tableIds || !Array.isArray(tableIds) || tableIds.length === 0) {
        return res.status(400).json({ error: 'Please select at least one table.' });
    }

    // Check conflicts
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

    // Calculate total price server-side
    const { data: dbTables } = await supabase.from('pool_tables').select('id, price');
    const priceMap = {};
    (dbTables || []).forEach(t => priceMap[t.id] = Number(t.price) || 50);

    const duration = Number(durationHours) || 1;
    const bookingFee = 15 * tableIds.length;
    let subtotal = 0;
    tableIds.forEach(id => { subtotal += (priceMap[id] || 50) * duration; });
    const totalAmountZAR = subtotal + bookingFee;
    const amountInCents = Math.round(totalAmountZAR * 100);

    // Request Checkout Session from Yoco
    const yocoPayload = JSON.stringify({
        amount: amountInCents,
        currency: 'ZAR',
        cancelUrl: `${req.protocol}://${req.get('host')}/`,
        successUrl: `${req.protocol}://${req.get('host')}/?payment=success&checkoutId={CHECKOUT_ID}`,
        metadata: {
            tableIds: JSON.stringify(tableIds),
            date,
            startTime,
            durationHours: duration,
            slot,
            userName,
            phone,
            userId,
            bookingFee,
            totalPrice: totalAmountZAR
        }
    });

    const options = {
        hostname: 'payments.yoco.com',
        port: 443,
        path: '/api/checkouts',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${YOCO_SECRET_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(yocoPayload)
        }
    };

    const yocoReq = https.request(options, yocoRes => {
        let body = '';
        yocoRes.on('data', chunk => body += chunk);
        yocoRes.on('end', () => {
            try {
                const responseData = JSON.parse(body);
                if (responseData.redirectUrl) {
                    res.json({
                        success: true,
                        redirectUrl: responseData.redirectUrl,
                        checkoutId: responseData.id
                    });
                } else {
                    res.status(500).json({ error: responseData.message || 'Yoco initialization failed.' });
                }
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse payment gateway response.' });
            }
        });
    });

    yocoReq.on('error', err => res.status(500).json({ error: err.message }));
    yocoReq.write(yocoPayload);
    yocoReq.end();
});

// 2. YOCO WEBHOOK ROUTE FOR ASYNCHRONOUS CONFIRMATION
app.post('/api/payments/webhook', async (req, res) => {
    try {
        const event = req.body;

        if (event && (event.type === 'payment.succeeded' || event.type === 'checkout.succeeded')) {
            const payload = event.payload || event.data || event;
            const meta = payload.metadata || {};

            const result = await recordBookingsFromMetadata(meta, payload.id);
            if (result.success) {
                console.log('Successfully inserted/upserted booking rows via webhook:', result.data);
            }
        }

        return res.status(200).json({ received: true });
    } catch (err) {
        console.error('Webhook processing exception:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// 3. SYNCHRONOUS CHECKOUT VERIFICATION FALLBACK
app.get('/api/payments/verify/:checkoutId', async (req, res) => {
    const { checkoutId } = req.params;

    const options = {
        hostname: 'payments.yoco.com',
        port: 443,
        path: `/api/checkouts/${checkoutId}`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${YOCO_SECRET_KEY}`
        }
    };

    const yocoReq = https.request(options, yocoRes => {
        let body = '';
        yocoRes.on('data', chunk => body += chunk);
        yocoRes.on('end', async () => {
            try {
                const checkoutData = JSON.parse(body);

                if (checkoutData.status === 'successful' || checkoutData.status === 'completed') {
                    const meta = checkoutData.metadata || {};
                    const result = await recordBookingsFromMetadata(meta, checkoutId);

                    return res.json({ success: true, bookings: result.data });
                } else {
                    return res.status(400).json({ error: `Checkout status is currently ${checkoutData.status}` });
                }
            } catch (e) {
                console.error('Checkout verification error:', e.message);
                return res.status(500).json({ error: 'Failed to verify payment session.' });
            }
        });
    });

    yocoReq.on('error', err => res.status(500).json({ error: err.message }));
    yocoReq.end();
});

// ==========================================
// PUBLIC & CLIENT API ROUTES
// ==========================================

// GET ALL POOL TABLES
app.get('/api/tables', async (req, res) => {
    const { data, error } = await supabase.from('pool_tables').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// GET AVAILABLE TABLES FOR A SPECIFIC HOURLY TIME SLOT AND DURATION
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

// WEEKLY AVAILABILITY MATRIX
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

// MULTI-TABLE USER BOOKINGS (DIRECT INSERT FOR PAY AT COUNTER)
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
            status: 'CONFIRMED',
            payment_status: 'DIRECT',
            is_active: true
        };
    });

    const { data, error } = await supabase.from('bookings').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({ success: true, count: data.length, bookings: data });
});

// ==========================================
// ADMIN DASHBOARD API ROUTES
// ==========================================

// GET DAY BOOKINGS & DAILY PAYMENT SUMMARY
app.get('/api/admin/day-bookings', async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date parameter required (YYYY-MM-DD)' });

    const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const bookings = data || [];
    let totalCash = 0;
    let totalCard = 0;

    bookings.forEach(b => {
        if (b.is_active !== false) {
            const price = Number(b.total_price) || 0;
            if (b.payment_method === 'CASH') totalCash += price;
            if (b.payment_method === 'CARD') totalCard += price;
        }
    });

    res.json({
        bookings,
        summary: { totalCash, totalCard }
    });
});

// EXECUTE ADMIN ACTION ITEM (WALK_IN, MAINTENANCE, RESERVED, CLEAR_TABLE)
app.post('/api/admin/action-item', async (req, res) => {
    const { actionType, tables, slots, date, durationHours, startTimeOverride, paymentMethod, price } = req.body;

    if (!tables || !Array.isArray(tables) || tables.length === 0) {
        return res.status(400).json({ error: 'At least one table must be selected.' });
    }

    const slotStr = (slots && slots[0]) ? slots[0] : '';
    const targetRange = convertSlotToRange(slotStr, startTimeOverride, durationHours);

    // 1. Handle CLEAR_TABLE Action
    if (actionType === 'CLEAR_TABLE') {
        const { data: activeBookings, error: fetchErr } = await supabase
            .from('bookings')
            .select('*')
            .eq('booking_date', date)
            .in('table_id', tables)
            .eq('is_active', true);

        if (fetchErr) return res.status(500).json({ error: fetchErr.message });

        const idsToClear = [];
        (activeBookings || []).forEach(b => {
            const bRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
            if (doSlotsOverlap(targetRange, bRange)) {
                idsToClear.push(b.id);
            }
        });

        if (idsToClear.length > 0) {
            const { error: updateErr } = await supabase
                .from('bookings')
                .update({ is_active: false, status: 'CANCELLED' })
                .in('id', idsToClear);

            if (updateErr) return res.status(500).json({ error: updateErr.message });
        }

        return res.json({ success: true, clearedCount: idsToClear.length });
    }

    // 2. Conflict checking for creation actions
    const { data: activeBookings, error: fetchErr } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date)
        .in('table_id', tables)
        .eq('is_active', true);

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });

    for (const tableId of tables) {
        const conflict = (activeBookings || []).find(b => {
            if (Number(b.table_id) !== Number(tableId)) return false;
            const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
            return doSlotsOverlap(targetRange, existingRange);
        });

        if (conflict) {
            return res.status(409).json({ error: `Table ${tableId} is already occupied in this target slot.` });
        }
    }

    // 3. Fetch current table prices
    const { data: dbTables } = await supabase.from('pool_tables').select('id, price');
    const priceMap = {};
    (dbTables || []).forEach(t => priceMap[t.id] = Number(t.price) || 60);

    const duration = Math.max(1, Math.ceil(Number(durationHours) || 1));

    let userName = 'Walk-In Customer';
    let status = 'WALK_IN';
    let pMethod = paymentMethod || null;
    let userIdentifier = 'WALK_IN_USER';

    if (actionType === 'MAINTENANCE') {
        userName = 'Maintenance Mode';
        status = 'MAINTENANCE';
        pMethod = 'N/A';
        userIdentifier = 'SYSTEM_MAINTENANCE';
    } else if (actionType === 'RESERVED') {
        userName = 'League / Reserved';
        status = 'RESERVED';
        pMethod = null;
        userIdentifier = 'SYSTEM_RESERVED';
    }

    const rows = tables.map(tableId => {
        const tableRate = priceMap[tableId] || 60;
        let calculatedPrice = 0;
        
        if (actionType === 'WALK_IN') {
            calculatedPrice = price ? (price / tables.length) : (tableRate * duration);
        } else if (actionType === 'RESERVED') {
            calculatedPrice = tableRate * duration;
        }

        return {
            ref_id: `${actionType.substring(0, 3)}-${Math.floor(100000 + Math.random() * 900000)}`.slice(0, 20),
            table_id: Number(tableId),
            booking_date: date,
            start_time: startTimeOverride,
            duration_hours: duration,
            time_slot: slotStr,
            user_name: userName,
            user_identifier: userIdentifier,
            phone: 'N/A',
            status: status,
            payment_method: pMethod,
            total_price: calculatedPrice,
            is_active: true
        };
    });

    const { data, error } = await supabase.from('bookings').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({ success: true, count: data.length, bookings: data });
});

// MONTHLY SUMMARY AGGREGATION
app.get('/api/admin/month-summary', async (req, res) => {
    const { month } = req.query; // YYYY-MM
    if (!month) return res.status(400).json({ error: 'Month parameter required (YYYY-MM)' });

    const startDate = `${month}-01`;
    const [year, monthNum] = month.split('-').map(Number);
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const endDate = `${month}-${String(daysInMonth).padStart(2, '0')}`;

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
        const amt = Number(b.total_price) || 0;
        const dKey = b.booking_date;

        if (!days[dKey]) {
            days[dKey] = { total: 0, cash: 0, card: 0, count: 0 };
        }

        days[dKey].total += amt;
        days[dKey].count += 1;
        totalRevenue += amt;

        if (b.payment_method === 'CASH') {
            days[dKey].cash += amt;
            totalCash += amt;
        } else if (b.payment_method === 'CARD') {
            days[dKey].card += amt;
            totalCard += amt;
        }
    });

    res.json({
        month,
        totalRevenue,
        totalCash,
        totalCard,
        days
    });
});

// EXPORT MONTHLY BOOKINGS TO CSV
app.get('/api/admin/export-month-csv', async (req, res) => {
    const { month } = req.query; // YYYY-MM
    if (!month) return res.status(400).send('Month parameter required (YYYY-MM)');

    const startDate = `${month}-01`;
    const [year, monthNum] = month.split('-').map(Number);
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const endDate = `${month}-${String(daysInMonth).padStart(2, '0')}`;

    const { data: bookings, error } = await supabase
        .from('bookings')
        .select('*')
        .gte('booking_date', startDate)
        .lte('booking_date', endDate)
        .order('booking_date', { ascending: true });

    if (error) return res.status(500).send(error.message);

    const headers = ['Ref ID', 'Date', 'Time Slot', 'Table ID', 'User Name', 'Phone', 'Status', 'Payment Method', 'Total Price', 'Is Active'];
    const csvRows = [headers.join(',')];

    (bookings || []).forEach(b => {
        const row = [
            escapeCSV(b.ref_id),
            escapeCSV(b.booking_date),
            escapeCSV(b.time_slot),
            escapeCSV(b.table_id),
            escapeCSV(b.user_name),
            escapeCSV(b.phone),
            escapeCSV(b.status),
            escapeCSV(b.payment_method),
            escapeCSV(b.total_price),
            escapeCSV(b.is_active)
        ];
        csvRows.push(row.join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bookings-${month}.csv"`);
    res.status(200).send(csvRows.join('\n'));
});

// GET ALL BOOKINGS (ADMIN OVERVIEW)
app.get('/api/admin/bookings', async (req, res) => {
    const { date, status } = req.query;
    let query = supabase.from('bookings').select('*').order('created_at', { ascending: false });

    if (date) query = query.eq('booking_date', date);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ADMIN OVERRIDE CREATE BOOKING (MANUAL ENTRY)
app.post('/api/admin/bookings', async (req, res) => {
    const { table_id, booking_date, start_time, duration_hours, time_slot, user_name, phone, status, notes } = req.body;

    const targetRange = convertSlotToRange(time_slot, start_time, duration_hours);

    const { data: activeBookings } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', booking_date)
        .eq('table_id', table_id)
        .eq('is_active', true);

    const conflict = (activeBookings || []).find(b => {
        const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
        return doSlotsOverlap(targetRange, existingRange);
    });

    if (conflict) {
        return res.status(409).json({ error: `Table ${table_id} is already booked for this slot.` });
    }

    const newBooking = {
        ref_id: `ADM-${Math.floor(100000 + Math.random() * 900000)}`.slice(0, 20),
        table_id: Number(table_id),
        booking_date,
        start_time,
        duration_hours: Number(duration_hours) || 1,
        time_slot,
        user_name: user_name || 'Admin Manual Booking',
        phone: phone || '',
        booking_fee: 0,
        total_price: 0,
        status: status || 'CONFIRMED',
        payment_status: 'ADMIN_OVERRIDE',
        notes: notes || 'Created via admin portal',
        is_active: true
    };

    const { data, error } = await supabase.from('bookings').insert([newBooking]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data[0]);
});

// UPDATE BOOKING STATUS (CANCEL, CONFIRM, COMPLETE, EXPIRE)
app.patch('/api/admin/bookings/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, is_active } = req.body;

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
        .from('bookings')
        .update(updates)
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

// MANAGE TABLES (ADMIN: UPDATE TABLE PRICE / MAINTENANCE STATUS)
app.patch('/api/admin/tables/:id', async (req, res) => {
    const { id } = req.params;
    const { price, is_maintenance, table_type } = req.body;

    const updates = {};
    if (price !== undefined) updates.price = price;
    if (is_maintenance !== undefined) updates.is_maintenance = is_maintenance;
    if (table_type !== undefined) updates.table_type = table_type;

    const { data, error } = await supabase
        .from('pool_tables')
        .update(updates)
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

// DELETE BOOKING (ADMIN HARD REMOVAL)
app.delete('/api/admin/bookings/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('bookings').delete().eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: `Booking ${id} permanently deleted.` });
});

// UPDATE BOOKING PAYMENT METHOD (CASH / CARD)
app.patch('/api/admin/bookings/:id/payment', async (req, res) => {
    const { id } = req.params;
    const { payment_method } = req.body;

    if (!['CASH', 'CARD'].includes(payment_method)) {
        return res.status(400).json({ error: 'Invalid payment method. Expected CASH or CARD.' });
    }

    const { data, error } = await supabase
        .from('bookings')
        .update({ payment_method })
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: 'Booking not found.' });

    res.json({ success: true, booking: data[0] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CueCraft Server running on port ${PORT}`));
