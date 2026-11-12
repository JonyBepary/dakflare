/**
 * Built-in Starter Template Library (Bangladesh Edition).
 *
 * Pre-engineered, high-accuracy templates for Mobile Financial Services (bKash, Nagad, Rocket),
 * Commercial Banks, and Doctor Chamber Booking confirmations.
 */

export interface StarterTemplate {
	id: string;
	name: string;
	category: 'mfs' | 'banking' | 'healthcare' | 'ecommerce' | 'logistics';
	description: string;
	channel: 'sms' | 'whatsapp' | 'telegram' | 'all';
	senderMask: string;
	triggerPhrases: string[];
	pattern: string;
	sampleBody: string;
	variables: Array<{
		name: string;
		type: string;
		description: string;
	}>;
	testSamples: Array<{
		body: string;
		expect_match: boolean;
		expected_vars: Record<string, string>;
	}>;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
	{
		id: 'mfs.bkash.payment_in',
		name: 'bKash Inbound Payment (Send Money & Cash In)',
		category: 'mfs',
		description: 'Extracts amount, customer account, trx_id, timestamp, and optional Ref clause.',
		channel: 'sms',
		senderMask: 'bKash',
		triggerPhrases: ['You have received', 'Cash In'],
		pattern:
			'(?:You have received|Cash In) (?:Tk|BDT)\\s*(?<amount>[0-9,]+(?:\\.[0-9]{1,2})?) from (?<sender_account>01[3-9][0-9]{8})(?:\\.|\\ssuccessful\\.)?(?:\\s*Ref (?<reference>[^\\.]+)\\.)?\\s*Fee (?:Tk|BDT) [0-9,\\.]+\\.\\s*Balance (?:Tk|BDT) [0-9,\\.]+\\.\\s*TrxID (?<trx_id>[A-Z0-9]{8,12}) at (?<timestamp>[0-9]{2}/[0-9]{2}/[0-9]{4} [0-9]{2}:[0-9]{2})',
		sampleBody:
			'You have received Tk 800.00 from 01999999999. Ref INV102. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 8G56H7J8K9 at 15/07/2026 11:24',
		variables: [
			{ name: 'amount', type: 'money_bdt', description: 'Transaction amount in BDT' },
			{ name: 'sender_account', type: 'phone_bd', description: 'Sender 11-digit mobile number' },
			{ name: 'reference', type: 'free_text', description: 'Sender reference / order ID' },
			{ name: 'trx_id', type: 'trx_id', description: '10-character unique transaction ID' },
			{ name: 'timestamp', type: 'datetime_bd', description: 'Transaction timestamp' }
		],
		testSamples: [
			{
				body: 'You have received Tk 800.00 from 01999999999. Ref INV102. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 8G56H7J8K9 at 15/07/2026 11:24',
				expect_match: true,
				expected_vars: {
					amount: '800.00',
					sender_account: '01999999999',
					reference: 'INV102',
					trx_id: '8G56H7J8K9',
					timestamp: '15/07/2026 11:24'
				}
			},
			{
				body: 'You have received Tk 540.00 from 01961116866. Ref PAY-540. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 3277235345 at 14/09/2026 12:38',
				expect_match: true,
				expected_vars: {
					amount: '540.00',
					sender_account: '01961116866',
					reference: 'PAY-540',
					trx_id: '3277235345',
					timestamp: '14/09/2026 12:38'
				}
			}
		]
	},
	{
		id: 'mfs.nagad.payment_in',
		name: 'Nagad Inbound Payment (Money Received)',
		category: 'mfs',
		description: 'Extracts customer phone, amount, TxnID, timestamp, and optional Ref.',
		channel: 'sms',
		senderMask: 'NAGAD',
		triggerPhrases: ['Money Received', 'Cash-In'],
		pattern:
			'(?:Money Received|Cash-In):\\s*(?:Tk|BDT)\\s*(?<amount>[0-9,]+(?:\\.[0-9]{1,2})?) from (?<sender_account>01[3-9][0-9]{8})\\.(?:\\s*Ref:\\s*(?<reference>[^\\.]+)\\.)?.*?TxnID:\\s*(?<trx_id>[A-Z0-9]{8,12}) at (?<timestamp>[0-9]{2}/[0-9]{2}/[0-9]{4} [0-9]{2}:[0-9]{2})',
		sampleBody:
			'Money Received: Tk 1,500.00 from 01712345678. Ref: ORDER99. Fee Tk 0.00. Balance Tk 5,420.00. TxnID: 7X8Y9Z01 at 10/11/2026 14:30',
		variables: [
			{ name: 'amount', type: 'money_bdt', description: 'Received amount in BDT' },
			{ name: 'sender_account', type: 'phone_bd', description: 'Sender 11-digit mobile number' },
			{ name: 'reference', type: 'free_text', description: 'Optional reference or order ID' },
			{ name: 'trx_id', type: 'trx_id', description: 'Nagad 8-character TxnID' },
			{ name: 'timestamp', type: 'datetime_bd', description: 'Payment timestamp' }
		],
		testSamples: [
			{
				body: 'Money Received: Tk 1,500.00 from 01712345678. Ref: ORDER99. Fee Tk 0.00. Balance Tk 5,420.00. TxnID: 7X8Y9Z01 at 10/11/2026 14:30',
				expect_match: true,
				expected_vars: {
					amount: '1500.00',
					sender_account: '01712345678',
					reference: 'ORDER99',
					trx_id: '7X8Y9Z01',
					timestamp: '10/11/2026 14:30'
				}
			}
		]
	},
	{
		id: 'mfs.rocket.payment_in',
		name: 'DBBL Rocket Transfer Alert',
		category: 'mfs',
		description: 'Extracts 12-digit Rocket account, amount, and 10-digit Txn ID.',
		channel: 'sms',
		senderMask: '16216',
		triggerPhrases: ['paid to', 'received from'],
		pattern:
			'(?:Tk\\.?|BDT)\\s*(?<amount>[0-9,]+(?:\\.[0-9]{1,2})?)\\s+(?:paid to|received from)\\s+(?<sender_account>01[3-9][0-9]{9}).*?Txn\\s*ID:\\s*(?<trx_id>[0-9]{10})',
		sampleBody:
			'Tk.200.00 paid to 017110000009. Fee: Tk 0.00. Txn ID: 1549973789, Date: 12-Dec-26 02:22:21 pm',
		variables: [
			{ name: 'amount', type: 'money_bdt', description: 'Transaction amount' },
			{ name: 'sender_account', type: 'phone_bd', description: '12-digit Rocket account number' },
			{ name: 'trx_id', type: 'trx_id', description: '10-digit Txn ID' }
		],
		testSamples: [
			{
				body: 'Tk.200.00 paid to 017110000009. Fee: Tk 0.00. Txn ID: 1549973789, Date: 12-Dec-26 02:22:21 pm',
				expect_match: true,
				expected_vars: {
					amount: '200.00',
					sender_account: '017110000009',
					trx_id: '1549973789'
				}
			}
		]
	},
	{
		id: 'bank.bd.npsb_beftn_credit',
		name: 'Commercial Bank Credit Alert (NPSB / BEFTN)',
		category: 'banking',
		description: 'Extracts masked account number (*1234), transfer channel, amount, and Trx ID.',
		channel: 'sms',
		senderMask: 'CityBank',
		triggerPhrases: ['credited with', 'A/C'],
		pattern:
			'A/C\\s*(?<account_masked>\\*+[0-9]{3,6})\\s+credited\\s+with\\s+(?:BDT|Tk\\.?)\\s*(?<amount>[0-9,]+(?:\\.[0-9]{1,2})?)\\s+via\\s+(?<transfer_channel>NPSB|BEFTN|RTGS).*?Trx\\s*ID[:\\s]+(?<trx_id>[A-Za-z0-9]+)',
		sampleBody:
			'A/C *1234 credited with BDT 25,000.00 via NPSB from BRAC Bank on 10-Nov-2026. Trx ID: TXN99887766. Available Bal: BDT 1,25,000.00',
		variables: [
			{ name: 'account_masked', type: 'bank_account', description: 'Masked bank account' },
			{ name: 'amount', type: 'money_bdt', description: 'Credited amount' },
			{ name: 'transfer_channel', type: 'enum', description: 'NPSB, BEFTN, or RTGS' },
			{ name: 'trx_id', type: 'trx_id', description: 'Bank transaction ID' }
		],
		testSamples: [
			{
				body: 'A/C *1234 credited with BDT 25,000.00 via NPSB from BRAC Bank on 10-Nov-2026. Trx ID: TXN99887766. Available Bal: BDT 1,25,000.00',
				expect_match: true,
				expected_vars: {
					account_masked: '*1234',
					amount: '25000.00',
					transfer_channel: 'NPSB',
					trx_id: 'TXN99887766'
				}
			}
		]
	},
	{
		id: 'health.chamber.serial_confirm',
		name: 'Doctor Chamber Booking & Computed Arrival',
		category: 'healthcare',
		description: 'Computes patient arrival time from serial number with buffer.',
		channel: 'sms',
		senderMask: 'Clinic',
		triggerPhrases: ['Serial'],
		pattern: 'Serial #(?<serial_no>[0-9]+) for (?<doctor_name>[^\\(]+)',
		sampleBody: 'Serial #14 for Dr. A. Karim. Visit Date: 12 Nov',
		variables: [
			{ name: 'serial_no', type: 'number', description: 'Patient serial number' },
			{ name: 'doctor_name', type: 'free_text', description: 'Doctor name' },
			{ name: 'arrival_time', type: 'datetime_bd', description: 'Computed arrival time' }
		],
		testSamples: [
			{
				body: 'Serial #14 for Dr. A. Karim. Visit Date: 12 Nov',
				expect_match: true,
				expected_vars: {
					serial_no: '14',
					doctor_name: 'Dr. A. Karim'
				}
			}
		]
	}
];
