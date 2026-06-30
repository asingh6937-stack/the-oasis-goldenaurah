const { handleLeadRequest } = require('../../lib/leads-handler');

exports.handler = async (event) => {
  const result = await handleLeadRequest({
    method: event.httpMethod,
    headers: event.headers,
    body: event.body,
    ip: event.headers['client-ip'] || event.headers['x-forwarded-for'],
  });

  return {
    statusCode: result.status,
    headers: result.headers,
    body: result.body,
  };
};
