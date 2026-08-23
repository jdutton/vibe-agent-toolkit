# Chunk Sizing

A chunker that only splits on headings is not a chunker, it is a table of
contents. Real documents carry sections far longer than any embedding model
will accept in a single pass, and those sections are the ones that decide how
a corpus behaves once it is indexed. This document exists to be one of them:
its body is deliberately longer than the default target size, so the splitter
has to divide it rather than hand it back whole.

The splitter walks paragraphs in order and packs them into an accumulating
buffer. Each paragraph contributes its own token count to a running total, and
the buffer is flushed the moment adding the next paragraph would carry that
total past the effective target. The effective target is the nominal target
scaled down by a padding factor, which reserves headroom for the prompt
scaffolding that will eventually wrap the retrieved text. Because the flush
happens before the overflowing paragraph is appended rather than after, a
paragraph is never divided when it could have started a fresh buffer instead.

Paragraph packing degrades gracefully when a single paragraph is itself larger
than the effective target. In that case the paragraph cannot start a fresh
buffer that fits, so the splitter drops down a level and packs individual
lines instead. Line packing follows the same greedy rule as paragraph packing,
which means a hard wrapped document divides along wrap boundaries and a
document written as one enormous unwrapped line divides not at all. That
asymmetry is worth remembering when comparing corpora: wrapping is a property
of the source text, and it silently changes how many pieces come out.

Token counts come from a real byte pair encoder rather than a character
heuristic, so the split points depend on the actual vocabulary rather than on
an approximation of it. Two passages of identical character length can produce
noticeably different counts when one is ordinary prose and the other is dense
with punctuation, identifiers, or code. A splitter tuned against a character
estimate will therefore drift away from the encoder it is meant to serve, and
the drift shows up as chunks that overflow the model limit only for certain
inputs.

Chunk count is the unit that indexing cost is billed in. Every chunk is
embedded exactly once, so doubling the number of chunks doubles the embedding
work and the storage the vectors occupy. Raising the target size lowers the
chunk count and lowers the cost, but it also coarsens retrieval, because a
larger chunk carries more material that has nothing to do with the query that
matched it. Lowering the target size sharpens retrieval and raises the bill.
There is no setting that is correct for every corpus, which is exactly why the
number has to be observable rather than assumed.

Boundaries also matter for what a retrieved chunk means on its own. A chunk
that begins in the middle of an argument reads as a fragment, and a reader,
human or model, has to reconstruct the missing setup from whatever else came
back. Preferring paragraph boundaries over line boundaries and heading
boundaries over paragraph boundaries is a bet that the author already marked
the seams where meaning divides most cleanly. The splitter honours that bet
until the size limit forces it not to.

Line numbers are carried alongside the text so a retrieved chunk can be traced
back to the region of the file it came from. The tracking is positional: the
splitter records where each chunk started within the original text and counts
the newlines that preceded it. Any change to how sections are extracted has to
keep that arithmetic honest, because a chunk that reports the wrong span is
worse than one that reports no span at all.

Ordering is part of the contract as well. Sections are extracted in document
order, and the pieces of a divided section are emitted in the order they were
packed, so the index preserves the sequence a reader would have followed. Each
piece also records the identifiers of the pieces on either side of it, which
is what makes it possible to widen a match back out into its neighbourhood
after retrieval. A splitter that emitted the same set of pieces in a different
order would satisfy a count assertion and still break that expansion.

Empty sections are dropped rather than emitted as empty pieces. A heading
immediately followed by another heading contributes nothing but its own text,
and a heading at the very end of a file contributes only the line it sits on.
Both cases are common in real documents, and both are places where an
off by one in the extraction arithmetic hides comfortably, because the
resulting piece is small enough that nobody reads it closely.

None of this is visible from a count that is only asserted to be positive. A
corpus of four short files will report a positive count whether the splitter
divides by tokens, divides by headings, or refuses to divide at all, and it
will keep reporting a positive count after any of those behaviours is broken.
The only assertion that distinguishes them is one taken over a corpus that
actually reaches the size limit, compared against a number that was recorded
when the behaviour was known to be right.

The practical consequence is that chunk count is a contract, not a statistic.
It is determined jointly by the heading structure of the corpus, the target
size, the padding factor, and the encoder. A change to any one of those four
moves the number, and a number that nobody pinned is a change that nobody
noticed.
