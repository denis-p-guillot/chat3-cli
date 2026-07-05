from odoo import http
from odoo.http import request

from odoo.addons.web.controllers.home import Home

from .main import PurplecloudBrainSsoService


class PurplecloudBrainSsoHome(Home):
    """Finish Brain AI SSO on /web/login, which is always routed to Odoo."""

    @http.route()
    def web_login(self, redirect=None, brain_sso_state=None, **kw):
        if request.session.uid and brain_sso_state:
            return PurplecloudBrainSsoService().issue_brain_redirect(state=brain_sso_state)
        return super().web_login(redirect=redirect, brain_sso_state=brain_sso_state, **kw)
