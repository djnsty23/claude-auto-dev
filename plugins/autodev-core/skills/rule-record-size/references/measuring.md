# Measuring record size, per language

Loaded on demand by `rule-record-size`. Every command here is one you can run
before changing anything, so the before-and-after exists rather than being
asserted.

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
cargo rustc -- -Zprint-type-sizes 2>&1 | grep -A20 "type: .Record."   # nightly
```

Lints worth turning on in `Cargo.toml` or `lib.rs`:

```toml
[lints.clippy]
large_enum_variant = "warn"
box_collection = "warn"
result_large_err = "warn"
```

`large_enum_variant` fires when the biggest variant is more than about three
times the smallest. `box_collection` catches `Box<Vec<T>>`, which is two
indirections for one container.

## Go

```go
fmt.Println(unsafe.Sizeof(entry), unsafe.Alignof(entry))
```

Padding from declaration order, which Go never reorders for you:

```bash
go vet -fieldalignment ./...
go install golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment@latest
fieldalignment -fix ./...     # rewrites declaration order in place
```

A slice header is 24 bytes and there is no boxed-slice type, so the equivalent of
`into_boxed_slice` is allocating at exact capacity:

```go
out := make([]Record, 0, len(in))   // not make([]Record, 0)
out = slices.Clip(out)              // drop spare capacity before retaining
```

An `interface{}` field is 16 bytes and hides an allocation for anything that does
not fit in a word. A `string` header is 16. Neither shows in a payload estimate.

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
