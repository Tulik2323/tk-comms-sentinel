// routes/topology.js — גרף טופולוגיה מ-LLDP
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getTopologyGraph } = require('../services/topology');

router.get('/', requireAuth, (req, res) => {
  try {
    const graph = getTopologyGraph({ includeStubs: req.query.stubs === '1' });
    res.json(graph);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
