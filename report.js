const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
    try {
        const { reporterId, reportedId, reason } = req.body;
        
        // You can add your Prisma database logic here later!
        console.log(`New report received for user ${reportedId}`);

        res.status(200).json({ success: true, message: 'Report submitted successfully' });
    } catch (error) {
        console.error("Error submitting report:", error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;