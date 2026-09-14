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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const verifyAdmin = (req, res, next) => {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Admin Password' });
    }
    next();
};

// 1. GET ALL POOL TABLES
app.get('/api/tables', async (req, res) => {
    const { data, error } = await supabase.from('pool_tables').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// 2. GET BOOKINGS BY DATE AND SLOT
app.get('/api/bookings', async (req, res) => {
    const { date, slot } = req.query;
    let query = supabase.from('bookings').select('*');
    
    if (date) query = query.eq('booking_date', date);
    if (slot) query = query.eq('time_slot', slot);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 3. CREATE A DIRECT CLIENT BOOKING
app.post('/api/bookings', async (req, res) => {
    const { tableId, date, slot, userName, phone, userId, bookingFee, totalPrice } = req.body;

    const { data: existing } = await supabase
        .from('bookings')
        .select('id')
        .eq('table_id', tableId)
        .eq('booking_date', date)
        .eq('time_slot', slot)
        .single();

    if (existing) {
        return res.status(409).json({ error: 'Table is already reserved for this date and time slot.' });
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
        user_identifier: userId
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// 4. ADMIN LOGIN VERIFICATION
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: ADMIN_PASSWORD });
    } else {
        res.status(401).json({ success: false, error: 'Incorrect password' });
    }
});

// Updated ADMIN ACTION ITEMS endpoint supporting default table prices
app.post('/api/admin/action-item', verifyAdmin, async (req, res) => {
    const { actionType, price, tables, slots, date } = req.body;

    if (!tables || !slots || tables.length === 0 || slots.length === 0) {
        return res.status(400).json({ error: 'Tables and slots are required.' });
    }

    try {
        // Fetch pool tables to retrieve standard prices if custom price is omitted
        const { data: dbTables, error: tableError } = await supabase
            .from('pool_tables')
            .select('id, price');

        if (tableError) throw tableError;

        const tablePriceMap = {};
        (dbTables || []).forEach(t => { tablePriceMap[t.id] = t.price || 0.00; });

        const insertRows = [];

        tables.forEach(tableId => {
            const numericTableId = Number(tableId);
            
            // Determine price based on action type
            let calculatedPrice = dbTables.price;
            if (actionType === 'WALK_IN') {
                calculatedPrice = (price !== undefined && price !== null && price !== '') 
                    ? parseFloat(price) 
                    : (tablePriceMap[numericTableId] || 0.00);
            }

            slots.forEach(slot => {
                const refPrefix = actionType === 'WALK_IN' ? 'WALK' : (actionType === 'MAINTENANCE' ? 'MNT' : 'RES');
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
                    status: actionType === 'RESERVED' ? 'RESERVED' : actionType,
                    payment_status: actionType === 'WALK_IN' ? 'UNPAID' : 'NO_PAYMENT_REQUIRED',
                    user_identifier: 'ADMIN'
                });
            });
        });

        // Delete conflicting bookings for the chosen target slots
        for (const row of insertRows) {
            await supabase.from('bookings')
                .delete()
                .eq('table_id', row.table_id)
                .eq('booking_date', row.booking_date)
                .eq('time_slot', row.time_slot);
        }

        const { data, error } = await supabase.from('bookings').insert(insertRows).select();
        if (error) throw error;

        res.status(201).json({ success: true, count: data.length, records: data });
    } catch (err) {
        console.error('Supabase Action Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 6. GET ALL BOOKINGS FOR A SPECIFIC DAY (ADMIN MATRIX)
app.get('/api/admin/day-bookings', verifyAdmin, async (req, res) => {
    const { date } = req.query;
    const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_date', date);

    if (error) return res.status(500).json({ error: error.message });
    
    const mapped = (data || []).map(b => ({
        ...b,
        date: b.booking_date,
        slot: b.time_slot
    }));
    
    res.json(mapped);
});

// 7. ADMIN: UPDATE PAYMENT STATUS & METHOD
app.patch('/api/admin/bookings/:id/payment', verifyAdmin, async (req, res) => {
    const { id } = req.params;
    const { paymentStatus, paymentMethod } = req.body;

    const { data, error } = await supabase
        .from('bookings')
        .update({ 
            payment_status: paymentStatus || 'PAID',
            payment_method: paymentMethod 
        })
        .eq('id', id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, booking: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CueCraft Server running on port ${PORT}`));