"""tools/code_version.py: the version of the published code is the last change that is not a label-pack refresh, and the check of a published copy against the latest code.
The history is built in a temporary repository (a code change merged as a pull request is a merge commit, and so is a pack refresh), and the published copy is a small local web server."""
import functools
import http.server
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import threading

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("code_version", ROOT / "tools" / "code_version.py")
code_version = importlib.util.module_from_spec(spec)
spec.loader.exec_module(code_version)
spec = importlib.util.spec_from_file_location("build_site", ROOT / "tools" / "build_site.py")
build_site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_site)


class Repo:
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.path.mkdir(parents=True, exist_ok=True)
        self.git("init", "-q")
        self.git("checkout", "-q", "-b", "master")
        for k, v in (("user.name", "t"), ("user.email", "t@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")):
            self.git("config", k, v)

    def git(self, *args, date=None):
        env = dict(os.environ)
        if date:
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = date
        p = subprocess.run(["git"] + list(args), cwd=self.path, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        assert p.returncode == 0, "git %s: %s" % (" ".join(args), p.stderr)
        return p.stdout.strip()

    def commit(self, files, message, date):
        for name, text in files.items():
            f = self.path / name
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(text, encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message, date=date)
        return self.git("rev-parse", "HEAD")

    def merged(self, branch, files, message, date):
        """What a pull request is: a branch with one commit, merged with a merge commit. Returns (the commit on the branch, the merge commit)."""
        self.git("checkout", "-q", "-b", branch)
        inner = self.commit(files, message, date)
        self.git("checkout", "-q", "master")
        self.git("merge", "-q", "--no-ff", "-m", "Merge " + branch, branch, date=date)
        return inner, self.git("rev-parse", "HEAD")


@pytest.fixture
def history(tmp_path):
    """A (code) <- C (the merge of a pack refresh) <- D (the merge of a code change, whose own commit is F)."""
    r = Repo(tmp_path / "repo")
    r.a = r.commit({"public/js/app.js": "1", "public/packs/index.js": "1"}, "start", "2026-01-01T10:00:00+02:00")
    _, r.c = r.merged("refresh", {"public/packs/list.js": "2", "public/packs/index.js": "2"}, "Refresh the shipped label packs", "2026-01-02T05:20:00+00:00")
    r.f, r.d = r.merged("feature", {"public/js/app.js": "3"}, "A change", "2026-01-03T12:00:00+01:00")
    return r


def short(sha):
    return sha[:7]


def test_the_version_is_the_last_change_that_is_not_a_pack_refresh(history):
    full, when = code_version.last_code_commit("HEAD", str(history.path))
    assert full == history.d and when == "2026-01-03T11:00:00Z", "the merge commit of the pull request (what GitHub shows), the date in UTC"
    assert code_version.version_info("HEAD", str(history.path))[0]["version"] == short(history.d)


def test_a_pack_refresh_published_after_a_code_change_does_not_move_the_version(history):
    before = code_version.last_code_commit("HEAD", str(history.path))
    history.merged("refresh2", {"public/packs/list.js": "4"}, "Refresh the shipped label packs", "2026-01-04T05:20:00+00:00")
    history.merged("refresh3", {"public/packs/other.js": "5", "public/packs/index.js": "5"}, "Refresh the shipped label packs", "2026-01-05T05:20:00+00:00")
    assert code_version.last_code_commit("HEAD", str(history.path)) == before


def test_looking_back_to_the_pack_refresh_gives_the_code_change_before_it(history):
    full, when = code_version.last_code_commit(history.c, str(history.path))
    assert full == history.a and when == "2026-01-01T08:00:00Z", "10:00 at +02:00 is 08:00 UTC"


@pytest.mark.parametrize("files", [{"README.md": "x"}, {"tools/x.py": "x"}, {"public/js/app.js": "9", "public/packs/index.js": "9"}, {"test/x.js": "x"}])
def test_anything_else_counts_as_a_change_even_together_with_packs(history, files):
    sha = history.commit(files, "change", "2026-01-06T12:00:00+00:00")
    assert code_version.last_code_commit("HEAD", str(history.path))[0] == sha


def test_a_history_of_only_pack_refreshes_has_no_version(tmp_path):
    r = Repo(tmp_path / "packs-only")
    r.commit({"public/packs/index.js": "1"}, "packs", "2026-01-01T10:00:00+00:00")
    with pytest.raises(SystemExit, match="No commit"):
        code_version.last_code_commit("HEAD", str(r.path))


def test_a_shallow_clone_is_refused_because_it_cannot_tell(history, tmp_path):
    clone = tmp_path / "shallow"
    subprocess.run(["git", "clone", "-q", "--depth", "1", history.path.as_uri(), str(clone)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with pytest.raises(SystemExit, match="shallow"):
        code_version.last_code_commit("HEAD", str(clone))


def test_the_command_prints_the_version_and_the_json_the_build_writes(history):
    tool = history.path / "tools"
    tool.mkdir()
    (tool / "code_version.py").write_text((ROOT / "tools" / "code_version.py").read_text(encoding="utf-8"), encoding="utf-8")     # it looks at the repository it lives in
    plain = subprocess.run([sys.executable, str(tool / "code_version.py")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    assert plain.returncode == 0 and plain.stdout.strip() == "%s 2026-01-03T11:00:00Z" % short(history.d), plain
    as_json = subprocess.run([sys.executable, str(tool / "code_version.py"), "--json"], stdout=subprocess.PIPE, universal_newlines=True)
    assert json.loads(as_json.stdout) == {"version": short(history.d), "committed": "2026-01-03T11:00:00Z", "about": code_version.ABOUT}


def test_the_two_tools_say_the_same_about_text():
    assert build_site.ABOUT == code_version.ABOUT


# ---- the check of a published copy --------------------------------------------------------------------------------------------------------

class Published:
    """A folder served over http on this machine: the published copy."""
    def __init__(self, folder):
        self.folder = pathlib.Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)

        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(self.folder)))
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def serve(self, version, **more):
        (self.folder / "version.json").write_text(json.dumps(dict({"version": version}, **more)), encoding="utf-8")

    def close(self):
        self.server.shutdown(); self.server.server_close()


@pytest.fixture
def site(tmp_path):
    p = Published(tmp_path / "site")
    yield p
    p.close()


def run_check(history, site, **kw):
    lines = []
    code = code_version.check(site.url, "master", repo=str(history.path), out=lines.append, **kw)
    return code, "\n".join(lines)


def test_a_copy_that_holds_the_latest_code_is_up_to_date(history, site):
    site.serve(short(history.d), committed="2026-01-03T11:00:00Z")
    code, text = run_check(history, site)
    assert code == 0 and "Up to date." in text and short(history.d) in text, text


def test_a_copy_that_is_behind_says_by_how_many_changes(history, site):
    site.serve(short(history.a))
    code, text = run_check(history, site)
    assert code == 1 and "Behind by 2 changes" in text, text
    site.serve(short(history.c))
    code, text = run_check(history, site)
    assert code == 1 and "Behind by 1 change on" in text, text


def test_the_label_pack_refresh_after_the_code_does_not_make_a_copy_look_behind(history, site):
    site.serve(short(history.d))
    history.merged("refresh2", {"public/packs/list.js": "4"}, "Refresh the shipped label packs", "2026-01-04T05:20:00+00:00")
    code, text = run_check(history, site)
    assert code == 0 and "Up to date." in text, text


def test_a_published_commit_that_this_repository_does_not_have_is_said_so(history, site):
    site.serve("deadbee")
    code, text = run_check(history, site)
    assert code == 1 and "not in this repository" in text, text


def test_it_can_tell_whether_a_change_of_yours_is_in_what_is_published(history, site):
    site.serve(short(history.d))
    code, text = run_check(history, site, contains=history.f)
    assert code == 0 and "is in the published version" in text, text
    site.serve(short(history.c))
    code, text = run_check(history, site, contains=history.f)
    assert code == 1 and "is NOT in the published version yet" in text, text
    code, text = run_check(history, site, contains="0123456789abcdef")
    assert code == 1 and "is not a commit of this repository" in text, text


def test_a_copy_without_a_version_or_that_cannot_be_reached_is_an_error_not_a_pass(history, site):
    (site.folder / "version.json").write_text("{}", encoding="utf-8")
    with pytest.raises(SystemExit, match="has no version"):
        code_version.check(site.url, "master", repo=str(history.path), out=lambda s: None)
    (site.folder / "version.json").write_text("not json", encoding="utf-8")
    with pytest.raises(SystemExit, match="Could not read"):
        code_version.check(site.url, "master", repo=str(history.path), out=lambda s: None)
    site.close()
    with pytest.raises(SystemExit, match="Could not read"):
        code_version.check(site.url, "master", repo=str(history.path), out=lambda s: None)


# ---- the files that have to agree ------------------------------------------------------------------------------------------------------------

def test_the_pack_paths_are_what_the_daily_refresh_adds():
    refresh = (ROOT / ".github" / "workflows" / "refresh-packs.yml").read_text(encoding="utf-8")
    added = re.findall(r"^\s*git add (\S+)\s*$", refresh, re.M)
    assert added, "the refresh workflow stages something"
    for path in added:
        assert any(path.rstrip("/") == p or path.startswith(p + "/") for p in code_version.PACK_PATHS), "%s is staged by the refresh but is not in PACK_PATHS, so a refresh would move the version" % path


@pytest.mark.parametrize("name", ["deploy.yml", "pages.yml"])
def test_both_deploys_read_the_whole_history_and_pass_the_version_to_the_build(name):
    wf = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
    assert "fetch-depth: 0" in wf, "a shallow checkout cannot tell the last change to the code"
    assert "tools/code_version.py" in wf and "--code-version" in wf and "--code-date" in wf
    assert '--version "${GITHUB_SHA::7}"' in wf, "the address stamp of the scripts stays the deploy's own commit: a changed pack has to reach browsers"
