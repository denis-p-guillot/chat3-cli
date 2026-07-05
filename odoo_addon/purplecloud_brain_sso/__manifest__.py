{
    "name": "PurpleCloud Brain SSO",
    "version": "19.0.1.0.4",
    "category": "Hidden",
    "summary": "Hand off Odoo SSO login to PurpleCloud Brain AI",
    "depends": ["base", "web"],
    "data": [
        "security/ir.model.access.csv",
        "data/ir_config_parameter.xml",
        "views/res_config_settings_views.xml",
    ],
    "installable": True,
    "application": False,
    "license": "LGPL-3",
}
