require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse form data securely
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static HTML/CSS/JS files
app.use(express.static(__dirname));

// Create a MariaDB/MySQL Connection Pool using your Hostinger .env variables
const pool = mysql.createPool({
    host: process.env.DB_HOST, // Make sure this is 127.0.0.1 in your .env if localhost fails
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test the database connection on startup
pool.getConnection()
    .then(conn => {
        console.log('Securely connected to MariaDB Database');
        conn.release(); // Release connection back to the pool
    })
    .catch(err => console.error('Database connection error:', err.message));

// Configure Nodemailer Transporter using Hostinger SMTP
const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- MULTI-PAGE ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/services', (req, res) => res.sendFile(path.join(__dirname, 'services.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'contact.html')));

// --- SECURE FORM SUBMISSION & EMAIL API ---
app.post('/api/contact', async (req, res) => {
    try {
        const { projectType, name, email, message } = req.body;

        // Basic validation
        if (!projectType || !name || !email || !message) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        // 1. Generate 6-digit Reference Number (IST Timezone)
        const istFormatter = new Intl.DateTimeFormat('en-GB', { 
            timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
        });
        // Converts current time like 14:30:45 to 143045
        const timeString = istFormatter.format(new Date()).replace(/:/g, ''); 
        
        const prefix = projectType === 'One-Time Build' ? 'OTB' : 'AR';
        const finalReference = `${prefix}-${timeString}`;

        // 2. Insert into MariaDB Database (using Prepared Statements for security)
        const sqlQuery = 'INSERT INTO contacts (reference_number, project_type, name, email, message) VALUES (?, ?, ?, ?, ?)';
        await pool.execute(sqlQuery, [finalReference, projectType, name, email, message]);

        // 3. Construct Admin Notification Email (Sent to you)
        const adminMailOptions = {
            from: `"WebNova System" <${process.env.EMAIL_USER}>`,
            to: process.env.ADMIN_EMAIL,
            subject: `New Secure Lead: ${projectType} [${finalReference}]`,
            text: `WEBNOVA TECHNOLOGIES - NEW LEAD\n\nReference: ${finalReference}\nType: ${projectType}\nName: ${name}\nEmail: ${email}\n\nTransmission Payload:\n${message}`
        };

        // 4. Construct Client Confirmation Email (HTML Formatted, sent to client)
        const clientMailOptions = {
            from: `"WebNova Technologies" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Transmission Received - Reference: ${finalReference}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #0A192F; padding: 20px;">
                    <h2 style="color: #00D2FF;">WebNova Technologies</h2>
                    <p>Hello <strong>${name}</strong>,</p>
                    <p>Your request for a <strong>${projectType}</strong> has been securely logged in our system.</p>
                    <p>Your official tracking reference is: <strong>${finalReference}</strong></p>
                    <p>Our engineering team will review your transmission payload and initialize contact shortly.</p>
                    <hr style="border: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #888;">This is an automated system message. Do not reply directly to this email.</p>
                </div>
            `
        };

        // 5. Send Both Emails
        await transporter.sendMail(adminMailOptions);
        await transporter.sendMail(clientMailOptions);

        // 6. Send Success Response to Frontend
        res.status(200).json({ 
            success: true, 
            message: `Transmission received. Secure reference number: ${finalReference}. Confirmation email dispatched.` 
        });
        
    } catch (error) {
        console.error('System Error:', error);
        res.status(500).json({ success: false, message: 'System error during processing. Please try again later.' });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`WebNova Central Core active on port ${port}`);
});
