const express = require('express');
const path = require('path');
const app = express();

// Hostinger will automatically provide the PORT environment variable
const port = process.env.PORT || 3000;

// This tells the server to serve your index.html and any other files
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
    console.log(`WebNova Server is active on port ${port}`);
});
