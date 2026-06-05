const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getAvailableTasks, createTask, verifyTask, getMyTasks } = require('../controllers/taskController');
const { pauseCampaign, resumeCampaign, cancelCampaign } = require('../controllers/campaignController');

router.get('/',           authenticate, getAvailableTasks);
router.get('/my',         authenticate, getMyTasks);
router.post('/',          authenticate, createTask);
router.post('/:id/verify',   authenticate, verifyTask);
router.post('/:id/complete', authenticate, verifyTask); // backwards compat
router.patch('/:id/pause',   authenticate, pauseCampaign);
router.patch('/:id/resume',  authenticate, resumeCampaign);
router.delete('/:id',        authenticate, cancelCampaign);

module.exports = router;
