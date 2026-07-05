import logging
import secrets
import urllib.parse
from datetime import timedelta

from odoo import fields, http
from odoo.exceptions import AccessDenied
from odoo.http import request

_logger = logging.getLogger(__name__)


class PurplecloudBrainSsoController(http.Controller):
    @http.route("/purplecloud/brain/sso/return", type="http", auth="user")
    def sso_return(self, state=None, **kw):
        brain_url = (
            request.env["ir.config_parameter"]
            .sudo()
            .get_param("purplecloud.brain.public_url", "")
            .strip()
            .rstrip("/")
        )
        if not brain_url:
            return request.make_response(
                "<h1>PurpleCloud Brain SSO</h1>"
                "<p>Set <code>purplecloud.brain.public_url</code> in Odoo settings.</p>",
                headers=[("Content-Type", "text/html; charset=utf-8")],
                status=503,
            )

        code = secrets.token_urlsafe(32)
        request.env["purplecloud.brain.sso.code"].sudo().create(
            {
                "code": code,
                "user_id": request.env.user.id,
                "login": request.env.user.login,
            }
        )

        params = {"code": code}
        if state:
            params["state"] = state
        target = f"{brain_url}/api/odoo/sso/callback?{urllib.parse.urlencode(params)}"
        return request.redirect(target, 303)

    @http.route("/purplecloud/brain/sso/exchange", type="json", auth="none", csrf=False)
    def sso_exchange(self, code, secret):
        expected = (
            request.env["ir.config_parameter"]
            .sudo()
            .get_param("purplecloud.brain.shared_secret", "")
            .strip()
        )
        if not expected or not secrets.compare_digest(str(secret or ""), expected):
            raise AccessDenied("Invalid Brain AI shared secret.")

        rec = (
            request.env["purplecloud.brain.sso.code"]
            .sudo()
            .search([("code", "=", code), ("used", "=", False)], limit=1)
        )
        if not rec:
            raise AccessDenied("Invalid or expired SSO code.")

        age = fields.Datetime.now() - rec.create_date
        if age > timedelta(minutes=5):
            rec.sudo().write({"used": True})
            raise AccessDenied("SSO code expired.")

        rec.sudo().write({"used": True})
        user = rec.user_id
        expiration = fields.Datetime.now() + timedelta(days=90)
        api_key = (
            request.env["res.users.apikeys"]
            .sudo()
            .with_user(user)
            ._generate("rpc", "PurpleCloud Brain AI", expiration)
        )
        _logger.info("Issued Brain AI API key for Odoo user %s", user.login)
        return {"login": rec.login, "api_key": api_key}
