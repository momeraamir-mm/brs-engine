const brs = require("../../../packages/node/bin/brs.node");

/**
 * Regression tests for the compile-time loop-context check: `continue for`/`exit for`
 * are only valid inside a `for`/`for each` loop, and `continue while`/`exit while` only
 * inside a `while` loop. A real Roku rejects the mismatched cases at compile time
 * (error &h8d, e.g. "Continue For is not inside a For loop"), so the simulator must too —
 * the simulator must never be more permissive than a device.
 */
describe("parser loop-context validation", () => {
    let parser;

    beforeEach(() => {
        parser = new brs.Parser();
    });

    function parse(source) {
        const { tokens } = brs.Lexer.scan(source);
        return parser.parse(tokens);
    }

    describe("rejects mismatched loop keywords", () => {
        test("'continue for' inside a 'while' loop (the AudioShelf device bug)", () => {
            const { errors } = parse(`
                while true
                    continue for
                end while
            `);
            expect(errors.some((e) => /continue for.*not inside a 'for' loop/.test(e.message))).toBe(true);
        });

        test("'exit for' inside a 'while' loop", () => {
            const { errors } = parse(`
                while true
                    exit for
                end while
            `);
            expect(errors.some((e) => /exit for.*not inside a 'for' loop/.test(e.message))).toBe(true);
        });

        test("'continue while' inside a 'for' loop", () => {
            const { errors } = parse(`
                for i = 0 to 5
                    continue while
                end for
            `);
            expect(errors.some((e) => /continue while.*not inside a 'while' loop/.test(e.message))).toBe(true);
        });

        test("'exit while' inside a 'for each' loop", () => {
            const { errors } = parse(`
                for each item in items
                    exit while
                end for
            `);
            expect(errors.some((e) => /exit while.*not inside a 'while' loop/.test(e.message))).toBe(true);
        });

        test("'continue for' with no enclosing loop at all", () => {
            const { errors } = parse(`
                continue for
            `);
            expect(errors.some((e) => /continue for.*not inside a 'for' loop/.test(e.message))).toBe(true);
        });
    });

    describe("accepts correct usage (regression guard against over-rejecting)", () => {
        test("'continue for' inside a 'for' loop", () => {
            const { errors } = parse(`
                for i = 0 to 5
                    continue for
                end for
            `);
            expect(errors).toEqual([]);
        });

        test("'continue for' inside a 'for each' loop", () => {
            const { errors } = parse(`
                for each item in items
                    continue for
                end for
            `);
            expect(errors).toEqual([]);
        });

        test("'continue while' / 'exit while' inside a 'while' loop", () => {
            const { errors } = parse(`
                while true
                    continue while
                    exit while
                end while
            `);
            expect(errors).toEqual([]);
        });

        test("keyword targets an outer loop of the matching kind through a nested loop of the other kind", () => {
            // `continue for` is legal here: the enclosing `for` loop is its target,
            // even though the innermost loop is a `while` (mirrors the interpreter's propagation).
            const { errors } = parse(`
                for i = 0 to 5
                    while true
                        continue for
                    end while
                end for
            `);
            expect(errors).toEqual([]);
        });
    });

    describe("function bodies are their own loop scope", () => {
        test("'continue for' inside a function nested in a 'for' loop does not see the outer loop", () => {
            const { errors } = parse(`
                for i = 0 to 5
                    cb = function()
                        continue for
                    end function
                end for
            `);
            expect(errors.some((e) => /continue for.*not inside a 'for' loop/.test(e.message))).toBe(true);
        });
    });
});
