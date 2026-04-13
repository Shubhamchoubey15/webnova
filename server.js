require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const nodemailer = require('nodemailer');
const request = require('request');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// --- Database Setup ---
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test connection & Auto-Create OTP Table for Multi-Process Safety
pool.getConnection()
    .then(async conn => {
        console.log('Securely connected to MariaDB Database');
        
        // This prevents the "Worker Memory Wipe" issue on Hostinger
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS otp_verification (
                mobile VARCHAR(20) PRIMARY KEY,
                otp VARCHAR(10) NOT NULL,
                expires_at BIGINT NOT NULL
            )
        `);
        console.log('Database OTP Verification table ready.');
        
        conn.release();
    })
    .catch(err => console.error('Database connection error:', err.message));

// --- Email Setup ---
const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true, 
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/services', (req, res) => res.sendFile(path.join(__dirname, 'services.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'contact.html')));

// --- 1. SEND OTP (DATABASE BACKED) ---
app.post('/api/send-otp', async (req, res) => {
    const { mobile, country_code } = req.body;
    const cleanMobile = mobile ? mobile.trim() : '';

    if (!cleanMobile) {
        return res.status(400).json({ success: false, message: 'Mobile number required.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + (5 * 60 * 1000); // 5 mins from now

    try {
        // Save to Database (Updates if user requested multiple times)
        await pool.execute(
            'INSERT INTO otp_verification (mobile, otp, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE otp = ?, expires_at = ?',
            [cleanMobile, otp, expiresAt, otp, expiresAt]
        );

        console.log(`Saved DB OTP for ${cleanMobile}: ${otp}`);

        // Send via Authkey
        const options = {
            method: 'GET',
            url: 'https://api.authkey.io/request', 
            qs: {
                authkey: process.env.AUTHKEY_API,
                mobile: cleanMobile,
                country_code: country_code || '91',
                sid: process.env.AUTHKEY_SENDER, 
                otp: otp,   
                var1: otp   
            }
        };

        request(options, function (error, response, body) {
            if (error || (body && (body.includes('error') || body.includes('false')))) {
                 console.log("AUTHKEY FAILED:", body || error);
                 return res.status(500).json({ success: false, message: 'Provider rejected SMS.' });
            } else {
                 res.status(200).json({ success: true, message: 'OTP Dispatched. Valid for 5 minutes.' });
            }
        });

    } catch (dbError) {
        console.error('Database Error during OTP creation:', dbError);
        res.status(500).json({ success: false, message: 'System error generating OTP.' });
    }
});

// --- 2. SECURE FORM SUBMISSION (DATABASE BACKED) ---
app.post('/api/contact', async (req, res) => {
    try {
        const { projectType, name, email, mobile, otp, message } = req.body;

        const cleanMobile = mobile ? mobile.trim() : '';
        const cleanOtp = otp ? otp.trim() : '';

        if (!projectType || !name || !email || !cleanMobile || !cleanOtp || !message) {
            return res.status(400).json({ success: false, message: 'All fields and OTP are required.' });
        }

        // --- FETCH OTP FROM DATABASE ---
        const [rows] = await pool.execute('SELECT * FROM otp_verification WHERE mobile = ?', [cleanMobile]);

        if (rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No OTP requested for this number.' });
        }

        const record = rows[0];

        // Check Expiration
        if (Date.now() > record.expires_at) {
            await pool.execute('DELETE FROM otp_verification WHERE mobile = ?', [cleanMobile]);
            return res.status(400).json({ success: false, message: 'OTP has expired. Request a new one.' });
        }

        // Check Match
        if (record.otp !== cleanOtp) {
            return res.status(400).json({ success: false, message: 'Invalid OTP. Please try again.' });
        }

        // OTP is valid! Delete it to prevent reuse.
        await pool.execute('DELETE FROM otp_verification WHERE mobile = ?', [cleanMobile]);

        // Generate Reference & Insert into DB
        const timeString = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(/:/g, ''); 
        const finalReference = `PLAN-${timeString}`;
        const detailedMessage = `Verified Mobile: ${cleanMobile}\n\nTransmission Payload:\n${message}`;

        await pool.execute('INSERT INTO contacts (reference_number, project_type, name, email, message) VALUES (?, ?, ?, ?, ?)', [finalReference, projectType, name, email, detailedMessage]);

        // Email notifications
        const adminMailOptions = { from: `"WebNova System" <${process.env.EMAIL_USER}>`, to: process.env.ADMIN_EMAIL, subject: `New Secure Lead (Verified): ${projectType} [${finalReference}]`, text: `Reference: ${finalReference}\nType: ${projectType}\nName: ${name}\nMobile: ${cleanMobile} (OTP VERIFIED)\nEmail: ${email}\n\nPayload:\n${message}` };
        const clientMailOptions = { from: `"WebNova Technologies" <${process.env.EMAIL_USER}>`, to: email, subject: `Transmission Received - Ref: ${finalReference}`, html: `<div style="font-family: Arial; padding: 20px;"><h2 style="color: #00D2FF;">WebNova Technologies</h2><p>Hello <strong>${name}</strong>,</p><p>Your payload has been securely logged and your mobile verified.</p><p>Tracking reference: <strong>${finalReference}</strong></p></div>` };

        await transporter.sendMail(adminMailOptions);
        await transporter.sendMail(clientMailOptions);

        res.status(200).json({ success: true, message: `Transmission received. Reference: ${finalReference}.` });
        
    } catch (error) {
        console.error('System Error:', error);
        res.status(500).json({ success: false, message: 'System error during processing.' });
    }
});

app.listen(port, () => console.log(`WebNova Central Core active on port ${port}`));
