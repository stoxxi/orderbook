# Engine Invariants

## Numerical

- No floats
- All prices and quantities are BigInt

## Order Lifecycle

- One owner at a time
- `_limit !== null` ⇒ order is live

## Solvency

- Executed notional ≤ reserved balance

## Recovery

- All pointers reset on deserialize
