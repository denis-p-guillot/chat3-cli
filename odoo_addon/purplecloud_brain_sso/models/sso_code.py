from odoo import fields, models


class PurplecloudBrainSsoCode(models.Model):
    _name = "purplecloud.brain.sso.code"
    _description = "One-time PurpleCloud Brain SSO exchange code"
    _order = "create_date desc"

    code = fields.Char(required=True, index=True)
    user_id = fields.Many2one("res.users", required=True, ondelete="cascade")
    login = fields.Char(required=True)
    used = fields.Boolean(default=False)
    create_date = fields.Datetime(default=fields.Datetime.now)
