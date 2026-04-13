require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const nodemailer = require('nodemailer');
const request = require('request');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Database Setup
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
    .then(conn => {
        console.log('Securely connected to MariaDB Database');
        conn.release();
    })
    .catch(err => console.error('Database connection error:', err.message));

// Email Transporter Setup
const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true, 
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// In-Memory OTP Store
const otpStore = {};

// --- MULTI-PAGE ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/services', (req, res) => res.sendFile(path.join(__dirname, 'services.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'contact.html')));

// --- ROUTE: SEND OTP VIA AUTHKEY.IO ---
app.post('/api/send-otp', (req, res) => {
    console.log("\n==== OTP REQUEST INITIATED ====");
    
    const { mobile, country_code } = req.body;
    console.log(`Target Mobile: ${mobile}, Country: ${country_code || '91'}`);

    if (!mobile) {
        console.log("FAILED: No mobile number provided.");
        return res.status(400).json({ success: false, message: 'Mobile number required.' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[mobile] = otp; 
    console.log(`Generated OTP: ${otp}`);

    // Authkey.io integration
    const options = {
        method: 'GET',
        url: 'https://api.authkey.io/request', 
        qs: {
            authkey: process.env.AUTHKEY_API,
            sms: `Your WebNova secure verification code is: ${otp}`,
            mobile: mobile,
            country_code: country_code || '91',
            sender: process.env.AUTHKEY_SENDER
        }
    };

    console.log("Calling Authkey API...");

    request(options, function (error, response, body) {
        if (error) {
            console.error('CRITICAL ERROR: Failed to reach Authkey API:', error);
            return res.status(500).json({ success: false, message: 'Failed to dispatch OTP.' });
        }
        
        console.log('Authkey HTTP Status Code:', response && response.statusCode);
        console.log('Authkey Raw Response:', body);

        // Check if Authkey actually accepted it
        if (body && body.includes('error')) {
             console.log("AUTHKEY REJECTED THE SMS.");
        } else {
             console.log("AUTHKEY ACCEPTED THE SMS.");
        }

        res.status(200).json({ success: true, message: 'OTP Dispatched. Check your phone.' });
    });
});

// --- SECURE FORM SUBMISSION & EMAIL API ---
app.post('/api/contact', async (req, res) => {
    try {
        const { projectType, name, email, mobile, otp, message } = req.body;

        // 1. Validation
        if (!projectType || !name || !email || !mobile || !otp) {
            return res.status(400).json({ success: false, message: 'All fields and OTP are required.' });
        }

        // 2. Verify OTP
        if (otpStore[mobile] !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid or Expired OTP.' });
        }
        delete otpStore[mobile]; // Clear OTP after successful use

        // 3. Generate Reference Number
        const istFormatter = new Intl.DateTimeFormat('en-GB', { 
            timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
        });
        const timeString = istFormatter.format(new Date()).replace(/:/g, ''); 
        const finalReference = `PLAN-${timeString}`;

        // Append Mobile to the message so it fits in your existing DB schema
        const detailedMessage = `Verified Mobile: ${mobile}\n\nClient Notes:\n${message || 'Standard Plan Selection'}`;

        // 4. Insert into MariaDB
        const sqlQuery = 'INSERT INTO contacts (reference_number, project_type, name, email, message) VALUES (?, ?, ?, ?, ?)';
        await pool.execute(sqlQuery, [finalReference, projectType, name, email, detailedMessage]);

        // 5. Admin Email
        const adminMailOptions = {
            from: `"WebNova System" <${process.env.EMAIL_USER}>`,
            to: process.env.ADMIN_EMAIL,
            subject: `New Secure Lead (Verified): ${projectType} [${finalReference}]`,
            text: `WEBNOVA TECHNOLOGIES - NEW LEAD\n\nReference: ${finalReference}\nType: ${projectType}\nName: ${name}\nEmail: ${email}\nMobile: ${mobile} (OTP VERIFIED)\n\nPayload:\n${message}`
        };

        // 6. Client Email
        const clientMailOptions = {
            from: `"WebNova Technologies" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Transmission Received - Reference: ${finalReference}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #0A192F; padding: 20px;">
                    <h2 style="color: #00D2FF;">WebNova Technologies</h2>
                    <p>Hello <strong>${name}</strong>,</p>
                    <p>Your request for the <strong>${projectType}</strong> has been securely logged and your mobile number has been verified.</p>
                    <p>Your official tracking reference is: <strong>${finalReference}</strong></p>
                    <p>Our engineering team will initialize contact shortly.</p>
                </div>
            `
        };

        await transporter.sendMail(adminMailOptions);
        await transporter.sendMail(clientMailOptions);

        res.status(200).json({ success: true, message: `Transmission received. Secure reference: ${finalReference}.` });
        
    } catch (error) {
        console.error('System Error:', error);
        res.status(500).json({ success: false, message: 'System error during processing.' });
    }
});

// Start Server
app.listen(port, () => console.log(`WebNova Central Core active on port ${port}`));
