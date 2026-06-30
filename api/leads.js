const { handleLeadRequest } = require('../lib/leads-handler');

module.exports = async function leads(req, res) {
  const result = await handleLeadRequest({
    method: req.method,
    headers: req.headers,
    body: req.body,
    ip: req.socket && req.socket.remoteAddress,
  });

  Object.entries(result.headers).forEach(([key, value]) => res.setHeader(key, value));
  res.status(result.status).send(result.body);
};
