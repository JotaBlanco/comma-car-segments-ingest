"""The dashboard page: PAGE_HTML, assembled from the four page_* modules.

Still one module-level HTML string served verbatim by main.py - no build step,
no template engine - but split by role once the Bootstrap grid and the SVG car
landed: page_style (widget CSS), page_markup (grid + car), page_vehicle (the
speed/rotation model) and page_script (controls, polling, charts). The two JS
halves share a single <script> element, so they share one scope.

Bootstrap 5.3 is loaded as a plain stylesheet from jsDelivr: the browser
fetches it, not the container. If a framing page's CSP ever blocks it, vendor
bootstrap.min.css next to this file and serve it from Flask - the class names
do not change.
"""

from page_markup import BODY_HTML
from page_script import DASHBOARD_JS
from page_style import STYLE_CSS
from page_vehicle import VEHICLE_JS

BOOTSTRAP_CSS_URL = "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"

PAGE_HTML = f"""<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Battery Simulator</title>
<link rel="stylesheet" href="{BOOTSTRAP_CSS_URL}">
<style>
{STYLE_CSS}
</style>
</head>
{BODY_HTML}
<script>
{VEHICLE_JS}
{DASHBOARD_JS}
</script>
</body>
</html>"""
