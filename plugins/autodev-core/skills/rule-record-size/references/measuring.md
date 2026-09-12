# Measuring record size, per language

Loaded on demand by `rule-record-size`. Adapt the illustrative type names and select installed toolchain capabilities
before execution. Preserve full diagnostics and actual process status.

## Rust

```rust
use std::mem::{size_of, align_of};

fn main() {
    println!("{:>6} {:>3}  CacheEntry", size_of::<CacheEntry>(), align_of::<CacheEntry>());
    println!("{:>6} {:>3}  Record",     size_of::<Record>(),     align_of::<Record>());
}
```

Freeze it so a regression fails the build rather than shipping:

```rust
const _: () = assert!(std::mem::size_of::<Record>() <= 24);
```

Per-variant sizes, which is what tells you which variant to box:

```bash
cargo +nightly rustc -- -Zprint-type-sizes > type-sizes.log 2>&1
# After checking the compiler exit status, inspect Record in the saved log.
```

Example lint policy in `Cargo.toml` (Rust source uses `#![warn(...)]` attributes
instead of TOML; confirm the installed lint names/defaults):

```toml
[lints.clippy]
large_enum_variant = "warn"
box_collection = "warn"
result_large_err = "warn"
```

Inspect the installed Clippy version's `large_enum_variant` threshold; it is
not a universal biggest/smallest ratio. `box_collection` catches `Box<Vec<T>>`, which is two
indirections for one container.

## Go

```go
fmt.Println(unsafe.Sizeof(entry), unsafe.Alignof(entry))
```

Padding from declaration order, which Go never reorders for you:

```bash
# Use a project-approved installed version of the separate analyzer.
fieldalignment ./...
# Review proposed field order changes and ABI impact before any -fix invocation.
```

On a 64-bit Go target a slice header is typically 24 bytes. To avoid retaining
an oversized backing array, copy the live elements (a shallow copy):

```go
var out []Record
if in != nil {
    out = make([]Record, len(in))
    copy(out, in)
}
// Old storage can be reclaimed only after every retaining alias is gone.
```

On that target interface and string headers are typically 16 bytes. Boxing,
escape analysis, pointed-to payloads and allocator behavior determine additional
allocations; do not infer total retained memory from header sizes.

## C and C++

```c
printf("%zu %zu\n", sizeof(struct CacheEntry), _Alignof(struct CacheEntry));
```

`pahole` prints padding per field and is the fastest way to find the holes:

```bash
pahole -C CacheEntry ./target/binary
gcc -Wpadded -c record.c        # warns at every inserted pad byte
```

`-Wpadded` is noisy by design. Run it once on the hot types, not repo-wide.

## Zig

```zig
@compileLog(@sizeOf(CacheEntry), @alignOf(CacheEntry));
```

`extern struct` keeps declaration order; a plain `struct` may reorder.

## Swift

```swift
MemoryLayout<CacheEntry>.size       // bytes actually used
MemoryLayout<CacheEntry>.stride     // bytes consumed in an array, size + padding
```

`stride` is the number that multiplies by the row count. Reporting `size` for an
array's memory undercounts.

## The RSS reading that actually decides it

`size_of` says the change did what you wrote. It does not say memory went down,
because the allocator rounds to size classes and a boxed variant becomes its own
allocation with its own header.

Linux, per process, during a run against a realistic working set:

```bash
grep VmRSS /proc/<pid>/status                  # one reading
while :; do grep -H VmRSS /proc/<pid>/status; sleep 1; done > rss.log
```

macOS: `ps -o rss= -p <pid>` in the same loop, in KB.

Take p50, p90 and p99 over the run rather than a single number. The instance with
the fullest cache is the one the change was for, and a mean hides it.

Allocator-level truth, when RSS and `size_of` disagree:

```bash
MALLOC_CONF=stats_print:true ./binary      # jemalloc, prints size-class bins
heaptrack ./binary && heaptrack_gui heaptrack.*.zst
valgrind --tool=massif ./binary && ms_print massif.out.*
```

The size-class table is what explains a `size_of` win that produced no RSS win.

## Reporting

Three numbers or it is not a result:

| | before | after |
|---|---|---|
| `size_of` of the record | | |
| RSS p50 / p90 / p99 under the same load | | |
| throughput and latency in the same run | | |

A memory number without the throughput number beside it is half a finding. The
whole point of the boxed-variant trade is that it can cost speed, and the only
honest way to present it is with both columns filled in.
