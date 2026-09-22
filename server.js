require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const app = express();

// Trust reverse proxies (Render, Heroku, Nginx) so req.protocol accurately detects HTTPS
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Notification Clients
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;


// Notification Dispatch Function
async function sendBookingConfirmation(bookingDetails) {
    const { ref_id, user_name, phone, user_identifier, booking_date, time_slot, table_ids, total_price } = bookingDetails;
    const email = user_identifier && user_identifier.includes('@') ? user_identifier : null;

    // Fetch table details (including names) for all booked table IDs
  let tableDisplayNames = Array.isArray(table_ids) ? table_ids.map(id => `Table ${id}`).join(', ') : `Table ${table_ids}`;
    if (Array.isArray(table_ids) && table_ids.length > 0) {
        const { data: dbTables } = await supabase
            .from('pool_tables')
            .select('id, name')
            .in('id', table_ids);

        if (dbTables && dbTables.length > 0) {
            const nameMap = {};
            dbTables.forEach(t => {
                // Checks if name is custom or standard default (e.g. "Table 1") to prevent duplicate "Table 1 (Table 1)" strings
                const isDefaultName = /^table\s*\d+$/i.test(t.name.trim());
                nameMap[t.id] = isDefaultName ? t.name : `Table ${t.id} (${t.name})`;
            });
            tableDisplayNames = table_ids.map(id => nameMap[id] || `Table ${id}`).join(', ');
        }
    }
    // Email Notification via Resend
    if (resend && email) {
        try {
            const { data, error } = await resend.emails.send({
                from: "Tee's Cueflix <onboarding@resend.dev>",
                to: [email],
                subject: `🎱 Booking Confirmation - Ref: ${ref_id}`,
                html: `
                    <div style="font-family: Arial, sans-serif; background-color: #0b0f17; color: #ffffff; padding: 24px; border-radius: 12px; max-width: 600px; margin: 0 auto;">
                        <h2 style="color: #10b981; margin-top: 0;">Booking Confirmed!</h2>
                        <p>Hi <strong>${user_name}</strong>,</p>
                        <p>Thank you for reserving with Tee's Cueflix. Here are your booking details:</p>
                        <table style="width: 100%; border-collapse: collapse; margin-top: 15px; color: #ffffff;">
                            <tr style="border-bottom: 1px solid #1f2937;"><td style="padding: 8px 0; font-weight: bold;">Reference ID:</td><td style="padding: 8px 0;">${ref_id}</td></tr>
                            <tr style="border-bottom: 1px solid #1f2937;"><td style="padding: 8px 0; font-weight: bold;">Date:</td><td style="padding: 8px 0;">${booking_date}</td></tr>
                            <tr style="border-bottom: 1px solid #1f2937;"><td style="padding: 8px 0; font-weight: bold;">Time Slot:</td><td style="padding: 8px 0;">${time_slot}</td></tr>
                            <tr style="border-bottom: 1px solid #1f2937;"><td style="padding: 8px 0; font-weight: bold;">Table(s):</td><td style="padding: 8px 0;">${tableDisplayNames}</td></tr>
                            <tr style="border-bottom: 1px solid #1f2937;"><td style="padding: 8px 0; font-weight: bold;">Total Paid:</td><td style="padding: 8px 0; color: #10b981; font-weight: bold;">R${total_price}</td></tr>
                        </table>
                        
                        <br/>
                         <p>Please have your bookings details ready to show at the counter.</p>
                        <p style="color: #9ca3af; font-size: 13px;">We look forward to seeing you on the felt!</p>
                    </div>
                `
            });

            if (error) {
                console.error('Resend API returned error:', error);
            } else {
                console.log(`Confirmation Email sent successfully to ${email}`);
            }
        } catch (err) {
            console.error('Error sending confirmation email:', err);
        }
    }
}

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

    const { data: tables, error: tablesErr } = await supabase
        .from('pool_tables')
        .select('*')
        .order('id');
    if (tablesErr) return res.status(500).json({ error: tablesErr.message });

    const { data: activeBookings, error: bookingsErr } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date)
        .eq('is_active', true);

    if (bookingsErr) return res.status(500).json({ error: bookingsErr.message });

    const targetRange = convertSlotToRange(null, startTime, duration);

    const availableTables = (tables || [])
        .filter(t => {
            const tableBookings = activeBookings.filter(b => Number(b.table_id) === Number(t.id));
            const hasConflict = tableBookings.some(b => {
                const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
                return doSlotsOverlap(targetRange, existingRange);
            });
            return !hasConflict;
        })
        .map(t => ({
            id: t.id,
            name: t.name || `Table ${t.table_number || t.id}`, // Fallback if name isn't a dedicated column
            number: t.table_number || t.number || t.id,
            ...t // Includes any additional original fields
        }));

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

// ==========================================
// YOCO PAYMENT INTEGRATION
// ==========================================

// 1. Create Checkout & Insert Pending Records into Database
app.post('/api/payments/yoco/create-checkout', async (req, res) => {
    const { tableIds, date, startTime, durationHours, slot, userName, phone, userIdentifier, bookingFeePerHour, bookingFeePerTable } = req.body;

    if (!tableIds || !Array.isArray(tableIds) || tableIds.length === 0) {
        return res.status(400).json({ error: 'Please select at least one table.' });
    }

    const targetRange = convertSlotToRange(slot, startTime, durationHours);

    // Verify table availability before initiating checkout
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

    // Calculate total price in CENTS
    const { data: dbTables } = await supabase.from('pool_tables').select('id, price');
    const priceMap = {};
    (dbTables || []).forEach(t => priceMap[t.id] = Number(t.price) || 50);

    const feePerHour = Number(bookingFeePerHour) || Number(bookingFeePerTable) || 15;
    const duration = Number(durationHours) || 1;
    const totalFeePerTable = feePerHour * duration;

    let totalRands = 0;
    tableIds.forEach(tId => {
        const basePrice = priceMap[tId] || 50;
        totalRands += (basePrice * duration) + totalFeePerTable;
    });

    const amountInCents = Math.round(totalRands * 100);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;

    try {
        const secretKey = process.env.YOCO_SECRET_KEY;
        if (!secretKey) {
            console.error('YOCO_SECRET_KEY is missing in environment variables.');
            return res.status(500).json({ error: 'Payment gateway configuration error.' });
        }

        const refId = `YOC-${Math.floor(100000 + Math.random() * 900000)}`;

        // Construct Yoco Payload (Clean redirect URL using refId)
        const yocoPayload = {
            amount: amountInCents,
            currency: 'ZAR',
            cancelUrl: `${baseUrl}/?payment=cancelled`,
            successUrl: `${baseUrl}/api/payments/yoco/success?refId=${refId}`,
            failureUrl: `${baseUrl}/?payment=failed`,
            metadata: {
                ref_id: String(refId),
                table_ids: tableIds.join(','),
                booking_date: String(date)
            }
        };

        const yocoResponse = await fetch('https://payments.yoco.com/api/checkouts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${secretKey.trim()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(yocoPayload)
        });

        const yocoData = await yocoResponse.json();

        if (!yocoResponse.ok) {
            console.error('Yoco API Error Detail:', JSON.stringify(yocoData, null, 2));
            return res.status(400).json({ 
                error: yocoData.message || yocoData.errorMessage || 'Failed to create Yoco payment session.' 
            });
        }

        // Pre-insert pending booking rows into DB linked to refId
        const pricePerTable = totalRands / tableIds.length;
        const pendingRows = tableIds.map(tableId => ({
            ref_id: refId,
            checkout_id: yocoData.id || null,
            table_id: tableId,
            booking_date: date,
            start_time: startTime || null,
            duration_hours: duration,
            time_slot: slot || '',
            user_name: userName || 'Guest Customer',
            phone: phone || null,
            user_identifier: userIdentifier || 'GUEST_USER',
            status: 'PENDING_PAYMENT',
            booking_fee: totalFeePerTable,
            total_price: pricePerTable,
            payment_status: 'PENDING',
            payment_method: 'ONLINE',
            is_active: false // Inactive until payment completes
        }));

        const { error: insertErr } = await supabase.from('bookings').insert(pendingRows);
        if (insertErr) {
            console.error('Failed to pre-store pending booking:', insertErr);
            return res.status(500).json({ error: 'Failed to initiate booking.' });
        }

        return res.json({ 
            success: true, 
            redirectUrl: yocoData.redirectUrl, 
            checkoutId: yocoData.id 
        });

    } catch (err) {
        console.error('Error creating Yoco checkout:', err);
        return res.status(500).json({ error: 'Internal server error processing payment.' });
    }
});

// 2. Redirect Success Callback (Queries DB by refId & Triggers Notifications)
app.get('/api/payments/yoco/success', async (req, res) => {
    const { refId } = req.query;

    if (!refId) {
        console.error('Missing refId in success callback');
        return res.redirect('/?payment=failed');
    }

    try {
        // Find pending bookings by ref_id
        const { data: pendingBookings, error: fetchErr } = await supabase
            .from('bookings')
            .select('*')
            .eq('ref_id', refId);

        if (fetchErr || !pendingBookings || pendingBookings.length === 0) {
            console.error('No pending bookings found for RefID:', refId);
            return res.redirect('/?payment=failed');
        }

        const alreadyConfirmed = pendingBookings[0].status === 'CONFIRMED';

        // Confirm status and set active
        const { error: updateErr } = await supabase
            .from('bookings')
            .update({
                status: 'CONFIRMED',
                payment_status: 'PAID',
                is_active: true
            })
            .eq('ref_id', refId);

        if (updateErr) {
            console.error('Error updating booking status:', updateErr);
            return res.redirect('/?payment=failed');
        }

        // Send Email Notification if not already sent
        if (!alreadyConfirmed) {
            const first = pendingBookings[0];
            const tableIds = pendingBookings.map(b => b.table_id);
            const totalPrice = pendingBookings.reduce((sum, b) => sum + (Number(b.total_price) || 0), 0);

            sendBookingConfirmation({
                ref_id: refId,
                user_name: first.user_name,
                phone: first.phone,
                user_identifier: first.user_identifier,
                booking_date: first.booking_date,
                time_slot: first.time_slot,
                table_ids: tableIds,
                total_price: totalPrice
            });
        }

        return res.redirect('/?payment=success');

    } catch (err) {
        console.error('Error in Yoco success callback:', err);
        return res.redirect('/?payment=failed');
    }
});

// 3. Webhook Handler Fallback
app.post('/api/payments/yoco/webhook', async (req, res) => {
    try {
        const event = req.body;

        if (event && event.type === 'payment.succeeded') {
            const payload = event.payload || {};
            const metadata = payload.metadata || {};
            const refId = metadata.ref_id;

            if (refId) {
                const { data: bookings } = await supabase
                    .from('bookings')
                    .select('*')
                    .eq('ref_id', refId);

                if (bookings && bookings.length > 0 && bookings[0].status !== 'CONFIRMED') {
                    await supabase
                        .from('bookings')
                        .update({
                            status: 'CONFIRMED',
                            payment_status: 'PAID',
                            is_active: true
                        })
                        .eq('ref_id', refId);

                    const first = bookings[0];
                    const tableIds = bookings.map(b => b.table_id);
                    const totalPrice = bookings.reduce((sum, b) => sum + (Number(b.total_price) || 0), 0);

                    sendBookingConfirmation({
                        ref_id: refId,
                        user_name: first.user_name,
                        phone: first.phone,
                        user_identifier: first.user_identifier,
                        booking_date: first.booking_date,
                        time_slot: first.time_slot,
                        table_ids: tableIds,
                        total_price: totalPrice
                    });
                }
            }
        }

        return res.status(200).send('Webhook Received');
    } catch (err) {
        console.error('Yoco Webhook Handler Error:', err);
        return res.status(500).send('Webhook Error');
    }
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
            ref_id: `${actionType.substring(0, 3)}-${Math.floor(100000 + Math.random() * 900000)}`.slice(0, 50),
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
            booking_fee: 0,
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
    const { table_id, booking_date, start_time, duration_hours, time_slot, user_name, phone, status } = req.body;

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
        ref_id: `ADM-${Math.floor(100000 + Math.random() * 900000)}`.slice(0, 50),
        table_id: Number(table_id),
        booking_date,
        start_time,
        duration_hours: Number(duration_hours) || 1,
        time_slot,
        user_name: user_name || 'Admin Manual Booking',
        user_identifier: 'ADMIN_OVERRIDE',
        phone: phone || '',
        booking_fee: 0,
        total_price: 0,
        status: status || 'CONFIRMED',
        payment_status: 'ADMIN_OVERRIDE',
        is_active: true
    };

    const { data, error } = await supabase.from('bookings').insert([newBooking]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data[0]);
});

// UPDATE FULL BOOKING (ADMIN EDIT)
app.put('/api/admin/bookings/:id', async (req, res) => {
    const { id } = req.params;
    const { user_name, phone, table_id, booking_date, start_time, duration_hours, time_slot, payment_method, total_price, status, is_active } = req.body;

    if (booking_date && table_id && time_slot) {
        const targetRange = convertSlotToRange(time_slot, start_time, duration_hours);

        const { data: activeBookings, error: fetchErr } = await supabase
            .from('bookings')
            .select('*')
            .eq('booking_date', booking_date)
            .eq('table_id', Number(table_id))
            .eq('is_active', true)
            .neq('id', id);

        if (fetchErr) return res.status(500).json({ error: fetchErr.message });

        const conflict = (activeBookings || []).find(b => {
            const existingRange = convertSlotToRange(b.time_slot, b.start_time, b.duration_hours);
            return doSlotsOverlap(targetRange, existingRange);
        });

        if (conflict) {
            return res.status(409).json({ error: `Table ${table_id} is already occupied during ${time_slot} on ${booking_date}.` });
        }
    }

    const updates = {};
    if (user_name !== undefined) updates.user_name = user_name;
    if (phone !== undefined) updates.phone = phone;
    if (table_id !== undefined) updates.table_id = Number(table_id);
    if (booking_date !== undefined) updates.booking_date = booking_date;
    if (start_time !== undefined) updates.start_time = start_time;
    if (duration_hours !== undefined) updates.duration_hours = Number(duration_hours);
    if (time_slot !== undefined) updates.time_slot = time_slot;
    if (payment_method !== undefined) updates.payment_method = payment_method;
    if (total_price !== undefined) updates.total_price = Number(total_price);
    if (status !== undefined) updates.status = status;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
        .from('bookings')
        .update(updates)
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: 'Booking not found.' });

    res.json({ success: true, booking: data[0] });
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
app.listen(PORT, () => console.log(`Tee's Cueflix Server running on port ${PORT}`));
