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

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

pool.getConnection()
    .then(conn => { console.log('Securely connected to MariaDB Database'); conn.release(); })
    .catch(err => console.error('Database connection error:', err.message));

const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true, 
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// --- ENHANCED SECURE OTP STORE ---
// Now stores objects with expiry times instead of just strings
const otpStore = {};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/services', (req, res) => res.sendFile(path.join(__dirname, 'services.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'contact.html')));

// --- ROUTE: SEND OTP VIA AUTHKEY.IO ---
app.post('/api/send-otp', (req, res) => {
    const { mobile, country_code } = req.body;
    const cleanMobile = mobile.trim();

    if (!cleanMobile) {
        return res.status(400).json({ success: false, message: 'Mobile number required.' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store OTP with a 5-MINUTE Expiry Timestamp for Security
    otpStore[cleanMobile] = {
        code: otp,
        expiresAt: Date.now() + (5 * 60 * 1000) // 5 minutes from now
    };
    
    console.log(`Generated OTP for ${cleanMobile}: ${otp}`);

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
        if (error) {
            console.error('API Error:', error);
            return res.status(500).json({ success: false, message: 'Failed to dispatch OTP.' });
        }
        
        if (body && (body.includes('error') || body.includes('false'))) {
             console.log("AUTHKEY REJECTED SMS:", body);
             return res.status(500).json({ success: false, message: 'Provider rejected SMS.' });
        } else {
             res.status(200).json({ success: true, message: 'OTP Dispatched. Valid for 5 minutes.' });
        }
    });
});

// --- SECURE FORM SUBMISSION API ---
app.post('/api/contact', async (req, res) => {
    try {
        const { projectType, name, email, mobile, otp, message } = req.body;

        // Clean inputs to prevent invisible spaces from causing errors
        const cleanMobile = mobile ? mobile.trim() : '';
        const cleanOtp = otp ? otp.trim() : '';

        if (!projectType || !name || !email || !cleanMobile || !cleanOtp || !message) {
            return res.status(400).json({ success: false, message: 'All fields and OTP are required.' });
        }

        // --- STRICT SECURE OTP VERIFICATION ---
        const record = otpStore[cleanMobile];

        if (!record) {
            return res.status(400).json({ success: false, message: 'No OTP requested for this number.' });
        }

        if (Date.now() > record.expiresAt) {
            delete otpStore[cleanMobile]; // Cleanup expired OTP
            return res.status(400).json({ success: false, message: 'OTP has expired. Request a new one.' });
        }

        if (record.code !== cleanOtp) {
            return res.status(400).json({ success: false, message: 'Invalid OTP. Please try again.' });
        }

        // If it passes all checks, delete it so it can't be reused (Replay Attack Prevention)
        delete otpStore[cleanMobile]; 

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
