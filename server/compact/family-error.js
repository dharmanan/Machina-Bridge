// Compact engine: the one error a family accumulator throws to make its family unavailable (with this code as the reason)
// without touching the spine or any other family. Its own module so protocol definitions can use it without import cycles.
export class FamilyError extends Error {
  constructor(code) { super(code); this.code = code; }
}
