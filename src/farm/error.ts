/** Expected pool conflicts are distinct from persistence failures. */
export class FarmError extends Error {
    constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503) {
        super(code);
    }
}
