# Copyright (c) 2013, 9T9IT and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from functools import partial
from toolz import compose, pluck, concatv

from optic_store.utils import pick


def execute(filters=None):
    columns = _get_columns()
    keys = compose(list, partial(pluck, "fieldname"))(columns)
    clauses, values = _get_filters(filters)
    data = _get_data(clauses, values, keys)
    return columns, data


def _get_columns():
    def make_column(key, label, type="Currency", options=None, width=120):
        return {
            "label": _(label),
            "fieldname": key,
            "fieldtype": type,
            "options": options,
            "width": width,
        }

    return [
        make_column("brand", "Brand", type="Link", options="Brand", width=180),
        make_column("qty", "Qty", type="Float"),
    ]


def _get_filters(filters):
    clauses = concatv(
        ["i.disabled = 0"],
        ["i.brand = %(brand)s"] if filters.brand else [],
        ["i.item_group = %(item_group)s"] if filters.item_group else [],
    )
    bin_clauses = concatv(
        ["b.item_code = i.item_code"],
        ["b.warehouse = %(warehouse)s"] if filters.warehouse else [],
    )
    return (
        {"clauses": " AND ".join(clauses), "bin_clauses": " AND ".join(bin_clauses)},
        filters,
    )


def _get_data(clauses, values, keys):
    items = frappe.db.sql(
        """
            SELECT
                i.brand AS brand,
                SUM(b.actual_qty) AS qty
            FROM `tabItem` AS i
            LEFT JOIN `tabBin` AS b ON {bin_clauses}
            WHERE {clauses}
            GROUP BY i.brand
        """.format(
            **clauses
        ),
        values=values,
        as_dict=1,
    )
    return map(partial(pick, keys), items)
