"""/swagger is the ASP.NET spelling of /docs (demo overlay, with a sync
fixup on api/api/main.py). The alias redirects rather than serving a second
copy, so there is exactly one docs page to keep working."""


def test_swagger_redirects_to_the_real_docs(client):
    response = client.get("/swagger", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/docs"


def test_the_alias_stays_out_of_the_schema(client):
    assert "/swagger" not in client.get("/openapi.json").json()["paths"]
