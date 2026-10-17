"""Python port of the client's movement simulation (client/src/sim).

The structure and operation order deliberately mirror the TypeScript so the two stay easy to diff, and
`shared/conformance/` scenarios (generated from the TypeScript) keep them in step. Parameter names keep the JSON's
camelCase (`hero.swing.maxRange`) for the same reason.
"""
