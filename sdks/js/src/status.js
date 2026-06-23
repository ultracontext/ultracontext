// Canonical mapping from UltraContext error codes to HTTP statuses.
export const STATUS_BY_CODE = {
    not_found: 404,
    invalid_input: 400,
    conflict: 409,
    busy: 503,
    incompatible_db: 500,
    internal: 500
}
