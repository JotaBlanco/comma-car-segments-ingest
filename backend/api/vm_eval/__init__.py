"""Evaluation of V-model test cases against decoded MF4 signal series.

This package is the execution step the Test Run stage used to leave open. It loads the
signal series a test case's pass criteria are written against, evaluates those criteria,
and returns both the verdict and the plot data that shows how the verdict was reached.

Layout:

* :mod:`.criteria` - the test-spec criterion vocabulary (windows, reductions, rules) as
  pure Python. No pandas, no numpy: the backend image carries neither.
* :mod:`.signals` - where the series come from. The lakehouse Query API when it is
  configured, the committed fixture otherwise.
* :mod:`.charts` - the plot payload: downsampled series, bound lines, breach spans.
* :mod:`.catalog` - the three implemented test cases, one function each, mirroring the
  cells of ``quixlab/notebooks/acc_performance_tests.py``.
* :mod:`.runner` - orchestration and the Mongo write-back.

Nothing is re-exported here on purpose. ``fixtures/build_acc_signals.py`` imports
:mod:`.catalog` from a workstation that has no pymongo installed, and a convenience import
of :mod:`.runner` in this file would drag the database driver in with it.
"""
