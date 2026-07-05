from odoo.http import request
from odoo.addons.web.controllers.utils import ensure_db

from odoo.addons.web.controllers.home import Home

from .main import PurplecloudBrainSsoService


class PurplecloudBrainSsoHome(Home):
    """Finish Brain AI SSO after /web/login (including website-themed login pages)."""

    @http.route(
        "/web/login",
        type="http",
        auth="none",
        readonly=False,
        website=False,
        sitemap=False,
    )
    def web_login(self, redirect=None, brain_sso_state=None, **kw):
        ensure_db()
        if request.httprequest.method == "GET" and request.session.uid and brain_sso_state:
            return PurplecloudBrainSsoService().issue_brain_redirect(state=brain_sso_state)
        return super().web_login(redirect=redirect, brain_sso_state=brain_sso_state, **kw)
