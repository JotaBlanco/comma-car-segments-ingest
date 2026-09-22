"""tm-connector — Kafka to Test Manager registry.

This app is ours; the comma-ingest reference has no equivalent. It consumes two
topics and calls four HTTP routes. It holds NO blob credentials: it never binds
blob storage, never imports quixportal, and never reads a stored object. The
bytes were already hashed by mf4-import and already read by mf4-decoder; this
service only states what they found.

Two independent lanes, no shared state between them:

* ``mf4_metadata`` -> ``POST /test-runs`` only. The run exists the moment the
  upload lands, before any decode, and even if a decode never happens.
* ``mf4-to-msg``   -> accumulate the signal inventory, then on the terminal
  ``file_complete`` marker: ``POST /test-runs`` (merge), ``POST /files``,
  ``POST /journal``.

Every batch carries its own ``file``, ``declared`` and ``header_properties``
blocks, so the second lane needs nothing from the first. Batches arriving
before their metadata message, or after a restart, are ordinary.
"""
