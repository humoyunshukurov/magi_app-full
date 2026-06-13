# magi-capture

Event capture, batching, and the tamper-evident prev-hash chain (ADR-0007). Turns raw
input signals into ordered, hash-linked events.

**Critical invariant:** no event payload ever contains document text — only behavioral
metadata (key *class*, lengths, timing). Lands in M1.
