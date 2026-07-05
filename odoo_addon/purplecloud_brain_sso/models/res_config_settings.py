from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    purplecloud_brain_public_url = fields.Char(
        string="Brain AI public URL",
        config_parameter="purplecloud.brain.public_url",
    )
    purplecloud_brain_shared_secret = fields.Char(
        string="Brain AI shared secret",
        config_parameter="purplecloud.brain.shared_secret",
    )
