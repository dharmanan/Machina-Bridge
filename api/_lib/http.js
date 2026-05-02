export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body));
}

export function methodNotAllowed(res, allowedMethods) {
  res.setHeader('Allow', allowedMethods.join(', '));
  return json(res, 405, { error: 'Method not allowed' });
}

export function badRequest(res, message) {
  return json(res, 400, { error: message });
}

export function serverError(res, error) {
  const message = error instanceof Error ? error.message : 'Unknown server error';
  return json(res, 500, { error: message });
}
