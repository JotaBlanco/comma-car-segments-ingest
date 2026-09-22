# Battery Sim (deploy-only plumbing)

Deploys the vendored `dc-battery-sim` plant at `battery-trace-gen/plant/main.py`
as a Quix Cloud service. This folder carries no application code of its own -
`app.yaml`, `dockerfile` and `requirements.txt` only. The plant is vendored and
pinned (`battery-trace-gen/PLANT_ORIGIN`); nothing here edits it.

Why a separate top-level folder: `quix.yaml`'s `application:` field names a
root-level directory - every existing entry in this repo's `quix.yaml` is one,
and neither the Quix docs nor the CLI reference show a nested path being
accepted. The dockerfile copies the whole repo as build context (standard for
this platform's dockerfiles - see `quix-python-base-image`) and then
`WORKDIR`s into `battery-trace-gen/plant` to run the real `main.py` from
there, so no vendored file is copied a second time.

Topics: `input` (`ui-data`, pedal/charge/ambient/heater/chiller writes from
Battery Sim UI), `output` (`battery-data`, pack state every 100 ms). See
`docs/architecture-battery-sim-ui.md` for the control laws and sign
conventions that produce the `input` messages.
