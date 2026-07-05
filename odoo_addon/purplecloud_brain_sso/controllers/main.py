import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.parse
from datetime import timedelta

from odoo import fields, http
from odoo.http import request

_logger = logging.getLogger(__name__)


class PurplecloudBrainSsoService(http.Controller):
    def _brain_public_url(self) -> str:
        return (
            request.env["ir.config_parameter"]
            .sudo()
            .get_param("purplecloud.brain.public_url", "")
            .strip()
            .rstrip("/")
        )

    def _shared_secret(self) -> str:
        return (
            request.env["ir.config_parameter"]
            .sudo()
            .get_param("purplecloud.brain.shared_secret", "")
            .strip()
        )

    def _sign_payload(self, payload_b64: str) -> str:
        secret = self._shared_secret()
        return hmac.new(secret.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()

    def issue_brain_redirect(self, state=None):
        """Build a signed redirect back to Brain AI for the logged-in user."""
        brain_url = self._brain_public_url()
        secret = self._shared_secret()
        if not brain_url:
            return request.make_response(
                "<h1>PurpleCloud Brain SSO</h1>"
                "<p>Set <code>purplecloud.brain.public_url</code> in Odoo settings "
                "(Settings → Integrations → PurpleCloud Brain AI).</p>",
                headers=[("Content-Type", "text/html; charset=utf-8")],
                status=503,
            )
        if not secret:
            return request.make_response(
                "<h1>PurpleCloud Brain SSO</h1>"
                "<p>Set <code>purplecloud.brain.shared_secret</code> in Odoo settings.</p>",
                headers=[("Content-Type", "text/html; charset=utf-8")],
                status=503,
            )

        user = request.env.user
        expiration = fields.Datetime.now() + timedelta(days=90)
        api_key = (
            request.env["res.users.apikeys"]
            .sudo()
            .with_user(user)
            ._generate("rpc", "PurpleCloud Brain AI", expiration)
        )
        _logger.info("Issued Brain AI API key for Odoo user %s", user.login)

        payload_obj = {
            "login": user.login,
            "api_key": api_key,
            "exp": int(time.time()) + 120,
        }
        if state:
            payload_obj["state"] = state
        payload_b64 = base64.urlsafe_b64encode(
            json.dumps(payload_obj, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
        sig = self._sign_payload(payload_b64)

        params = {"payload": payload_b64, "sig": sig}
        if state:
            params["state"] = state
        target = f"{brain_url}/api/odoo/sso/callback?{urllib.parse.urlencode(params)}"
        return request.redirect(target, 303)


# Legacy direct return routes (kept for older Brain AI builds).
_RETURN_ROUTES = (
    "/web/purplecloud/brain/sso/return",
    "/purplecloud/brain/sso/return",
)


class PurplecloudBrainSsoController(PurplecloudBrainSsoService):
    @http.route(
        "/web/brain_ai/sso/complete",
        type="http",
        auth="user",
        website=False,
        sitemap=False,
    )
    def sso_complete(self, brain_sso_state=None, **kw):
        if not brain_sso_state:
            return request.redirect("/web/login")
        return self.issue_brain_redirect(state=brain_sso_state)

    @http.route(_RETURN_ROUTES, type="http", auth="user", website=False, sitemap=False)
    def sso_return(self, state=None, **kw):
        return self.issue_brain_redirect(state=state)
