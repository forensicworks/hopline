"""The assistant asks only a model on this computer. There is no option that sends the evidence to a hosted service, so "the evidence never leaves
your computer" has no exception. The pages, scripts, styles, build tools and workflows are checked for the names of hosted-model services and of the headers
that carry their keys, and the assist module is checked for any address other than this computer. (Data files and the docs are not checked.) If you really want
a hosted option, change this test on purpose and say so in the README, SECURITY.md, the start page and the Assistant section."""
import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]

FORBIDDEN = ["anthropic", "x-api-key", "dangerous-direct-browser-access", "claudeRequest", "api.openai.com", "generativelanguage", "api.mistral.ai", "openrouter.ai",
             "api.groq.com", "api.deepseek.com", "api.perplexity.ai", "api.x.ai", "api.cohere", "bedrock-runtime", "openai.azure.com", "aiplatform.googleapis.com"]
THIS_COMPUTER = {"127.0.0.1", "localhost", "[::1]"}


def sources():
    out = [ROOT / "index.html", ROOT / "public" / "config.js"]
    for pattern in ("public/*.html", "public/js/*.js", "public/css/*.css", "tools/*.py", "tools/*.js", ".github/workflows/*.yml"):
        out += sorted(ROOT.glob(pattern))
    return [p for p in out if p.is_file()]


def test_the_list_of_files_that_are_checked_is_not_empty():
    names = {p.name for p in sources()}
    assert {"index.html", "workspace.html", "workspace.js", "hopline-assist.js", "hopline-cli.js", "build_site.py", "deploy.yml", "config.js"} <= names, names


@pytest.mark.parametrize("path", sources(), ids=lambda p: p.relative_to(ROOT).as_posix())
def test_no_page_script_style_tool_or_workflow_names_a_hosted_model_service(path):
    text = path.read_text(encoding="utf-8").lower()
    found = [w for w in FORBIDDEN if w.lower() in text]
    assert not found, "%s mentions %s: the assistant asks only a model on this computer" % (path.relative_to(ROOT).as_posix(), found)


def test_the_assist_module_names_no_address_but_this_computer():
    text = (ROOT / "public" / "js" / "hopline-assist.js").read_text(encoding="utf-8")
    hosts = {re.sub(r":\d+$", "", h) for h in re.findall(r"https?://([^\s/'\"`)<>]+)", text)}
    assert hosts, "the module names its local examples"
    assert hosts <= THIS_COMPUTER, sorted(hosts - THIS_COMPUTER)


def test_the_workspace_page_has_no_key_box_for_the_assistant():
    html = (ROOT / "public" / "workspace.html").read_text(encoding="utf-8")
    section = html[html.index('<details id="aiSection">'):html.index("</details>", html.index('id="aiHistory"'))]
    assert 'type="password"' not in section and "outbound" not in section, "the Assistant section has no key box and no outbound option"
