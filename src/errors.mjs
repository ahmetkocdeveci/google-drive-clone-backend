export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}
export function notFound() { return new HttpError(404, 'NOT_FOUND', 'Kaynak bulunamadı.') }
