---
name: rule-record-size
description: "A record's size is not its payload's size. An enum is as large as its biggest variant, a growable container carries capacity it will never use, and padding is invisible in the source. Multiplied by a million rows that is real memory. Load before defining a struct, enum or cache entry that will exist in bulk."
when_to_use: "Before defining or changing a type that will exist in the millions: a cache entry, a row, a parsed record, an event. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash
paths:
  - "**/*.rs"
  - "**/*.go"
  - "**/*.c"
  - "**/*.h"
  - "**/*.cc"
  - "**/*.cpp"
  - "**/*.hpp"
  - "**/*.zig"
  - "**/*.swift"
---

# The size of a record is not the size of its data

Per-record waste is the only kind that multiplies by a number nobody chose. The
row count is set by traffic, not by a design decision, so a byte you did not
notice is billed once per row forever.

`[reported]` Cloudflare's 1.1.1.1 resolver, from a public write-up read second
hand rather than from the post itself, so treat the figures as illustrative and
re-derive them before quoting: roughly 250 billion cached DNS entries, where one
wasted byte per entry is about 250 GB across the fleet. Four layout changes and
nothing else took p99 resident memory from 9.3 GB to 5.3 GB per instance, a 43%
cut, with insert throughput rising from about 625k to 900k entries per second.

The reason this needs a rule rather than a code review is that every one of those
four wastes is **invisible in the source**. The struct reads correctly, the types
are the obvious ones, and no test can fail. Only `size_of` says anything.

## 1. Measure the record against its payload, before anything else

One line, and almost nobody runs it:

```rust
println!("{} bytes", std::mem::size_of::<CacheEntry>());
```

Compare that number to the bytes you believe you are storing. A ratio above about
2 means the sections below apply. A ratio near 1 means stop reading and go do
something else.

Go: `unsafe.Sizeof(x)`, and `fieldalignment` in `go vet`. C and C++: `sizeof`,
and `pahole` prints padding per field. Zig: `@sizeOf`. Swift:
`MemoryLayout<T>.size` alongside `.stride`, which are not the same number.

**Write the assertion down.** A `const _: () = assert!(size_of::<T>() <= 64);`
turns a silent regression into a build failure, and it is the only thing that
stops the next field from quietly costing 8 bytes on every row.

## 2. An enum is as large as its largest variant, every time

The one that paid for the headline. A DNS record enum holds `A` at 4 bytes,
`AAAA` at 16, and `NAPTR` at roughly 136. Every value occupies the largest, so an
A record sat in 144 bytes and wasted 140 of them, on the variant that is most of
production traffic.

Box the fat variants. The enum collapses to about a pointer plus a tag, and the
rare variant pays an allocation it was always going to be worth.

```rust
enum Record {
    A(Ipv4Addr),           // 4 bytes, inline
    Aaaa(Ipv6Addr),        // 16 bytes, inline
    Naptr(Box<Naptr>),     // was ~136 inline, now 8
}
```

Clippy has `large_enum_variant` for exactly this and it is off by default in most
setups. Turn it on. The same shape appears as a tagged union in C, and in Go as a
struct with mutually exclusive fields, which is worse because nothing warns.

**The trade is real and must be measured, not assumed.** Boxing adds a pointer
chase on the boxed variants and breaks locality. Cloudflare's throughput went up
anyway, because smaller entries mean more of the working set fits in cache, and
they still had to do further work to recover locality. That is evidence, not a
guarantee, and it does not transfer to a type whose fat variant is the common
case. Check the variant distribution first: box the rare ones, keep the hot ones
inline.

## 3. A growable container inside an immutable record is pure waste

`Vec<T>` is `(ptr, capacity, len)`, 24 bytes. `Box<[T]>` is `(ptr, len)`, 16. The
capacity field only means something if you intend to grow, and a cache entry is
written once and read forever.

The second-order win is larger than the 8 bytes. Growth doubles, so a vector
holding 3 items owns 4 slots and one holding 5 owns 8. Average slack is 25 to 50
percent of the allocation and it appears in no struct-size calculation at all.

- `Vec<T>` to `Box<[T]>` with `.into_boxed_slice()`
- `String` to `Box<str>` with `.into_boxed_str()`
- `HashMap` to a sorted `Box<[(K, V)]>` when the map is small and read-only

Across eight such fields that is 64 bytes per record before counting the slack.

Go has no boxed-slice type, so the equivalent is allocating at exact capacity and
calling `slices.Clip` on anything retained long term. A slice header is 24 bytes
whatever you do.

## 4. A field the key already determines does not need storing

Every record in a DNS response repeats the queried name, and the hash map already
holds that name as its key. Storing it again is a pointer, a length, and a heap
allocation per record.

```rust
/// `None` means "the owner is the cache key".
owner: Option<Box<str>>,
```

`Option<Box<str>>` is the same size as `Box<str>`, because a `Box` is never null
and Rust puts the `None` case in the null pointer value. The discriminant is
free. The same holds for `Option<&T>`, `Option<NonZeroU32>` and any type with a
spare bit pattern. `Option<u32>` is **not** free and costs 8 bytes, because every
`u32` bit pattern is valid.

Look for any field derivable from the key, from a parent, or from a sibling
field. Each one is a whole allocation, not merely a few bytes.

## 5. N parallel containers over one logical array is N fat pointers

A DNS response has answer, authority and additional sections. Three
`Box<[Record]>` fields is three pointers and three lengths, 48 bytes, for records
that are always allocated and freed together.

One slice plus two offsets is 16 + 2 + 2, padded to 24:

```rust
records: Box<[Record]>,
authority_start: u16,
additional_start: u16,
```

It also turns three allocations into one, which removes two allocator headers
that `size_of` never showed you, and puts every record on one contiguous run.

## 6. Field order costs nothing in Rust and real bytes almost everywhere else

`repr(Rust)` reorders fields to minimise padding. `repr(C)`, C, C++ and Go do
not, so declaration order is layout order and a `bool` between two `u64` fields
costs 14 bytes of padding.

```c
struct bad  { uint64_t a; bool flag; uint64_t b; };  /* 24 bytes */
struct good { uint64_t a; uint64_t b; bool flag; };  /* 17, padded to 24 */
```

Sort fields widest first in any `repr(C)`, C, C++ or Go struct. `pahole` and
`go vet -fieldalignment` both find these without thinking.

## 7. `size_of` is a claim about the type, not about the memory you get back

This is where a layout change quietly delivers nothing, and it is the check most
often skipped.

Allocators round to size classes. Shrinking a record from 144 to 136 bytes can
save exactly zero, because both land in the same class, while 144 to 64 crosses
two boundaries and saves more than the arithmetic suggests. Boxing a variant
moves bytes out of the record and into a **separate** allocation that has its own
header and its own rounding, so the total can rise while `size_of` falls.

So the observable is RSS under a realistic working set, not `size_of`:

1. Record `size_of` before and after, which tells you the change did what you
   wrote.
2. Load a real working set and read RSS at p50, p90 and p99. A single reading
   hides the case that matters, which is the fullest instance.
3. Read throughput and latency in the same run. A memory win that costs 20% of
   throughput is a decision for someone else to make, not a silent one.

Report all three. A layout change reported on `size_of` alone has not been
verified, it has been described.

## 8. When this rule does not apply

A type instantiated a hundred times owes this nothing. Boxing its variants makes
it slower and harder to read for a saving measured in kilobytes.

The threshold is roughly: **does this type exist in the millions, or hold a
significant share of process memory?** If neither, write the obvious struct and
move on. Premature layout work is the same mistake as any other premature
optimisation, with the extra cost that the result reads worse.

The signal that it does apply: a process whose memory grows with row count rather
than with concurrency, an OOM that arrives at a predictable cache size, or a
`size_of` more than twice the payload on a type you allocate in a loop.

The per-language measurement recipes are in `references/measuring.md`.
