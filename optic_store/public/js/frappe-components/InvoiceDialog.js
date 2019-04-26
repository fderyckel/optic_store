export function print_invoice(sales_invoice_name, print_format, no_letterhead) {
  // from /frappe/public/js/frappe/form/print.js
  const w = window.open(
    frappe.urllib.get_full_url(
      `/printview?doctype=${encodeURIComponent(
        'Sales Invoice'
      )}&name=${encodeURIComponent(
        sales_invoice_name
      )}&trigger_print=1&format=${encodeURIComponent(
        print_format
      )}&no_letterhead=${no_letterhead ? '1' : '0'}&_lang=en`
    )
  );
  if (!w) {
    frappe.msgprint(__('Please enable pop-ups'));
  }
}

export default class InvoiceDialog {
  constructor(print_formats = [], mode_of_payments = []) {
    this.mode_of_payments = mode_of_payments.map(mode_of_payment => ({
      mode_of_payment,
    }));
    this.print_formats = print_formats;
    this.dialog = new frappe.ui.Dialog({
      title: 'Invoice & Print',
      fields: [
        {
          fieldname: 'loyalty_sec',
          fieldtype: 'Section Break',
          label: __('Loyalty Program'),
        },
        {
          fieldname: 'loyalty_card_no',
          fieldtype: 'Data',
          label: __('Loyalty Card No'),
        },
        {
          fieldname: 'loyalty_points_redeem',
          fieldtype: 'Int',
          label: __('Points to Redeem'),
          hidden: 1,
        },
        {
          fieldtype: 'Column Break',
        },
        {
          fieldname: 'loyalty_points_available',
          fieldtype: 'Int',
          label: __('Available Loyalty Points'),
          read_only: 1,
          hidden: 1,
        },
        {
          fieldname: 'loyalty_amount_available',
          fieldtype: 'Currency',
          label: __('Available Loyalty Amount'),
          read_only: 1,
          hidden: 1,
        },
        {
          fieldname: 'loyalty_amount_redeem',
          fieldtype: 'Currency',
          label: __('Amount to Redeem'),
          read_only: 1,
          hidden: 1,
        },
        {
          fieldname: 'payment_sec',
          fieldtype: 'Section Break',
          label: __('Payments'),
        },
        {
          fieldname: 'payments',
          fieldtype: 'Table',
          fields: [
            {
              fieldname: 'mode_of_payment',
              fieldtype: 'Link',
              options: 'Mode of Payment',
              label: __('Mode of Payment'),
              in_list_view: 1,
            },
            {
              fieldname: 'amount',
              fieldtype: 'Currency',
              label: __('Amount'),
              in_list_view: 1,
            },
          ],
          in_place_edit: true,
          data: this.mode_of_payments,
          get_data: () => this.mode_of_payments,
        },
        {
          fieldname: 'print_sec',
          fieldtype: 'Section Break',
          label: __('Print Formats'),
        },
        ...this.print_formats.map(pf => ({
          fieldtype: 'Check',
          fieldname: pf,
          label: __(pf),
        })),
      ],
    });
    this.init_state = {
      loyalty_card_no: null,
      loyalty_program: null,
      loyalty_points: 0,
      conversion_factor: 0,
      loyalty_points_redeem: 0,
      loyalty_amount_redeem: 0,
    };
  }
  async create_and_print(frm) {
    this.state = Object.assign({}, this.init_state);

    this.dialog.fields_dict.loyalty_card_no.change = async function() {
      const loyalty_card_no = this.dialog.get_value('loyalty_card_no');
      await this.handle_loyalty(frm, loyalty_card_no);
      [
        'loyalty_points_redeem',
        'loyalty_amount_redeem',
        'loyalty_points_available',
        'loyalty_amount_available',
      ].forEach(field =>
        this.dialog.fields_dict[field].toggle(!!loyalty_card_no)
      );
      this.dialog.fields_dict.loyalty_points_redeem.bind_change_event();
    }.bind(this);

    this.dialog.fields_dict.loyalty_points_redeem.change = () => {
      const loyalty_points_redeem =
        this.dialog.get_value('loyalty_points_redeem') || 0;

      const loyalty_amount_redeem =
        loyalty_points_redeem * flt(this.state.conversion_factor);
      const min_amount = Math.min(
        this.state.loyalty_points * flt(this.state.conversion_factor),
        frm.doc.rounded_total
      );
      if (loyalty_amount_redeem > min_amount) {
        frappe.throw(
          __(
            `Amount to Redeem cannot exceed ${format_currency(
              min_amount,
              frm.doc.currency
            )}`
          )
        );
      }
      this.dialog.set_values({ loyalty_amount_redeem });
      this.state = Object.assign({}, this.state, {
        loyalty_points_redeem,
        loyalty_amount_redeem,
      });
      this.set_payments(frm);
    };

    this.dialog.get_primary_btn().off('click');
    this.dialog.set_primary_action(
      'OK',
      async function() {
        const { name } = frm.doc;
        const values = this.dialog.get_values();
        const enabled_print_formats = this.print_formats.filter(
          pf => values[pf]
        );
        const payments = values.payments.map(({ mode_of_payment, amount }) => ({
          mode_of_payment,
          amount,
        }));
        this.dialog.hide();
        const {
          loyalty_points_redeem: loyalty_points,
          loyalty_program,
          loyalty_card_no,
        } = this.state;
        const { message: sales_invoice_name } = await frappe.call({
          method: 'optic_store.api.sales_order.invoice_qol',
          freeze: true,
          freeze_message: __('Creating Sales Invoice'),
          args: {
            name,
            payments,
            loyalty_card_no,
            loyalty_program,
            loyalty_points,
          },
        });
        frm.reload_doc();
        enabled_print_formats.forEach(pf => {
          print_invoice(sales_invoice_name, pf, 0);
        });
      }.bind(this)
    );

    this.dialog.set_df_property('loyalty_sec', 'hidden', 0);
    this.dialog.set_df_property('payment_sec', 'hidden', 0);
    this.dialog.fields_dict.loyalty_card_no.bind_change_event();
    await this.dialog.set_value('loyalty_card_no', null);
    this.dialog.fields_dict.loyalty_card_no.change();

    this.set_payments(frm);
    this.dialog.show();
  }
  set_payments(frm) {
    this.dialog.fields_dict.payments.grid.grid_rows.forEach(gr => {
      gr.doc.amount = 0;
      gr.refresh_field('amount');
    });

    let amount_to_set =
      frm.doc.rounded_total - this.state.loyalty_amount_redeem;
    const gift_card_balance = frm.doc.os_gift_cards.reduce(
      (a, { balance }) => a + balance,
      0
    );
    const gift_card_gr = this.dialog.fields_dict.payments.grid.grid_rows.find(
      ({ doc }) => doc.mode_of_payment === 'Gift Card'
    );
    if (gift_card_balance && gift_card_gr) {
      gift_card_gr.doc.amount = Math.min(gift_card_balance, amount_to_set);
      gift_card_gr.refresh_field('amount');
      amount_to_set -= gift_card_gr.doc.amount;
    }
    const first_payment_gr = this.dialog.fields_dict.payments.grid.grid_rows.filter(
      ({ doc }) => doc.mode_of_payment !== 'Gift Card'
    )[0];
    if (first_payment_gr) {
      first_payment_gr.doc.amount = amount_to_set;
      first_payment_gr.refresh_field('amount');
    }
  }
  async handle_loyalty(frm, loyalty_card_no) {
    if (loyalty_card_no) {
      const { customer, company } = frm.doc;
      const { message = {} } = await frappe.call({
        method: 'optic_store.api.loyalty_program.get_customer_loyalty_details',
        args: {
          customer,
          loyalty_card_no,
          expiry_date: frappe.datetime.get_today(),
          company,
        },
      });
      this.state = Object.assign({}, this.state, { loyalty_card_no }, message);
      const { loyalty_points, conversion_factor } = this.state;
      this.dialog.set_values({
        loyalty_points_available: loyalty_points,
        loyalty_amount_available: loyalty_points * flt(conversion_factor),
      });
    } else {
      this.dialog.set_values({
        loyalty_points_available: null,
        loyalty_amount_available: null,
        loyalty_amount_redeem: null,
      });
    }
  }
  async print_invoice(frm) {
    const print_formats = this.print_formats;
    this.dialog.get_primary_btn().off('click');
    this.dialog.set_primary_action('OK', async function() {
      const { name } = frm.doc;
      const values = this.get_values();
      const enabled_print_formats = print_formats.filter(pf => values[pf]);
      this.hide();
      const { message: invoices = [] } = await frappe.call({
        method: 'optic_store.api.sales_order.get_invoice',
        args: { name },
      });
      invoices.forEach(sales_invoice_name => {
        enabled_print_formats.forEach(pf => {
          print_invoice(sales_invoice_name, pf, 0);
        });
      });
    });
    this.dialog.set_df_property('loyalty_sec', 'hidden', 1);
    this.dialog.set_df_property('payment_sec', 'hidden', 1);
    this.dialog.show();
  }
}