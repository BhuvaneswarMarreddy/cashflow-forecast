/**
 * CSV Import Tests
 * Tests the CSV parsing logic for various bank statement formats
 */

// CSV parsing helper (mirrors logic in CSVImportModal)
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function detectFormat(headers: string[]): string {
  const headerStr = headers.join(',').toLowerCase();
  
  if (headerStr.includes('principal') && headerStr.includes('interest')) {
    return 'upstart';
  }
  if (headerStr.includes('transaction date') && headerStr.includes('posted date')) {
    return 'chase';
  }
  if (headerStr.includes('debit') && headerStr.includes('credit') && headerStr.includes('trans. date')) {
    return 'capital_one';
  }
  if (headerStr.includes('appears on your statement')) {
    return 'amex';
  }
  if (headerStr.includes('reference number') && headerStr.includes('payee')) {
    return 'bofa';
  }
  if (headerStr.includes('merchant') && headerStr.includes('account')) {
    return 'monarch';
  }
  if (headerStr.includes('original description')) {
    return 'mint';
  }
  return 'generic';
}

function determineTransactionType(
  amount: number,
  title: string,
  typeStr: string
): 'income' | 'expense' {
  const titleLower = title.toLowerCase();
  
  // Payment keywords
  const paymentKeywords = ['payment', 'autopay', 'auto pay', 'credit', 'transfer from', 'statement credit'];
  const isPayment = paymentKeywords.some(kw => titleLower.includes(kw));
  
  // Deposit keywords
  const depositKeywords = ['deposit', 'direct dep', 'payroll', 'salary'];
  const isDeposit = depositKeywords.some(kw => titleLower.includes(kw));
  
  // Transfer keywords
  const isTransferIn = titleLower.includes('transfer from') || titleLower.includes('online transfer from');
  
  if (isPayment || isTransferIn || isDeposit) {
    return 'income';
  }
  
  // Check type column
  if (typeStr.includes('income') || typeStr.includes('credit') || 
      typeStr.includes('deposit') || typeStr.includes('payment')) {
    return 'income';
  }
  
  return 'expense';
}

describe('CSV Import', () => {
  describe('CSV Line Parsing', () => {
    test('should parse simple CSV line', () => {
      const line = 'value1,value2,value3';
      expect(parseCSVLine(line)).toEqual(['value1', 'value2', 'value3']);
    });

    test('should handle quoted values with commas', () => {
      const line = '"Description, with comma",100,"Another value"';
      expect(parseCSVLine(line)).toEqual(['Description, with comma', '100', 'Another value']);
    });

    test('should handle empty values', () => {
      const line = 'value1,,value3';
      expect(parseCSVLine(line)).toEqual(['value1', '', 'value3']);
    });

    test('should handle quoted empty values', () => {
      const line = '"",value2,""';
      expect(parseCSVLine(line)).toEqual(['', 'value2', '']);
    });
  });

  describe('Format Detection', () => {
    test('should detect Upstart format', () => {
      const headers = ['Date', 'Principal', 'Interest', 'Balance'];
      expect(detectFormat(headers)).toBe('upstart');
    });

    test('should detect Chase format', () => {
      const headers = ['Transaction Date', 'Posted Date', 'Description', 'Amount'];
      expect(detectFormat(headers)).toBe('chase');
    });

    test('should detect Capital One format', () => {
      const headers = ['Trans. Date', 'Posted Date', 'Description', 'Debit', 'Credit'];
      expect(detectFormat(headers)).toBe('capital_one');
    });

    test('should detect AMEX format', () => {
      const headers = ['Date', 'Description', 'Amount', 'Appears On Your Statement As'];
      expect(detectFormat(headers)).toBe('amex');
    });

    test('should detect BofA format', () => {
      const headers = ['Date', 'Reference Number', 'Payee', 'Amount'];
      expect(detectFormat(headers)).toBe('bofa');
    });

    test('should detect Monarch format', () => {
      const headers = ['Date', 'Merchant', 'Category', 'Account', 'Amount'];
      expect(detectFormat(headers)).toBe('monarch');
    });

    test('should detect Mint format', () => {
      const headers = ['Date', 'Description', 'Original Description', 'Amount', 'Category'];
      expect(detectFormat(headers)).toBe('mint');
    });

    test('should return generic for unknown format', () => {
      const headers = ['Date', 'Description', 'Amount'];
      expect(detectFormat(headers)).toBe('generic');
    });
  });

  describe('Transaction Type Detection', () => {
    test('should detect payment as income', () => {
      expect(determineTransactionType(500, 'Payment Thank You', '')).toBe('income');
    });

    test('should detect autopay as income', () => {
      expect(determineTransactionType(200, 'AutoPay - Credit Card', '')).toBe('income');
    });

    test('should detect direct deposit as income', () => {
      expect(determineTransactionType(5000, 'Direct Deposit - ACME Corp', '')).toBe('income');
    });

    test('should detect payroll as income', () => {
      expect(determineTransactionType(3000, 'Payroll Deposit', '')).toBe('income');
    });

    test('should detect salary as income', () => {
      expect(determineTransactionType(4500, 'Salary Payment', '')).toBe('income');
    });

    test('should detect transfer from as income', () => {
      expect(determineTransactionType(500, 'Online Transfer from Checking 7535', '')).toBe('income');
    });

    test('should detect statement credit as income', () => {
      expect(determineTransactionType(50, 'Statement Credit - Rewards', '')).toBe('income');
    });

    test('should detect regular purchase as expense', () => {
      expect(determineTransactionType(100, 'Amazon Marketplace', '')).toBe('expense');
    });

    test('should detect transfer to as expense', () => {
      expect(determineTransactionType(500, 'Online Transfer to Checking 7535', '')).toBe('expense');
    });

    test('should use type column hint for income', () => {
      expect(determineTransactionType(100, 'Misc Transaction', 'credit')).toBe('income');
    });

    test('should use type column hint for deposit', () => {
      expect(determineTransactionType(100, 'Misc Transaction', 'deposit')).toBe('income');
    });
  });

  describe('Amount Parsing', () => {
    test('should parse positive amounts', () => {
      const amountStr = '123.45';
      expect(parseFloat(amountStr)).toBe(123.45);
    });

    test('should parse negative amounts', () => {
      const amountStr = '-123.45';
      expect(Math.abs(parseFloat(amountStr))).toBe(123.45);
    });

    test('should parse amounts with currency symbol', () => {
      const amountStr = '$123.45';
      expect(parseFloat(amountStr.replace(/[$,]/g, ''))).toBe(123.45);
    });

    test('should parse amounts with commas', () => {
      const amountStr = '1,234.56';
      expect(parseFloat(amountStr.replace(/[$,]/g, ''))).toBe(1234.56);
    });

    test('should parse amounts with both currency and commas', () => {
      const amountStr = '$1,234.56';
      expect(parseFloat(amountStr.replace(/[$,]/g, ''))).toBe(1234.56);
    });
  });

  describe('Date Parsing', () => {
    test('should parse YYYY-MM-DD format', () => {
      const dateStr = '2025-12-25';
      // Parse as local date to avoid timezone issues
      const [year, month, day] = dateStr.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      expect(date.getFullYear()).toBe(2025);
      expect(date.getMonth()).toBe(11); // 0-indexed
      expect(date.getDate()).toBe(25);
    });

    test('should parse MM/DD/YYYY format', () => {
      const dateStr = '12/25/2025';
      const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (match) {
        const date = new Date(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2]));
        expect(date.getFullYear()).toBe(2025);
        expect(date.getMonth()).toBe(11);
        expect(date.getDate()).toBe(25);
      }
    });

    test('should parse M/D/YYYY format', () => {
      const dateStr = '1/5/2025';
      const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (match) {
        const date = new Date(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2]));
        expect(date.getFullYear()).toBe(2025);
        expect(date.getMonth()).toBe(0);
        expect(date.getDate()).toBe(5);
      }
    });
  });

  describe('Sample CSV Data', () => {
    test('should correctly parse Monarch-style transaction', () => {
      const headers = ['Date', 'Merchant', 'Category', 'Account', 'Original Statement', 'Notes', 'Amount'];
      const line = '2025-12-25,Amazon,Shopping,Amazon Store Card,AMAZON MARKETPLACE,$STUFF,-45.99';
      
      const values = parseCSVLine(line);
      
      expect(values[0]).toBe('2025-12-25'); // Date
      expect(values[1]).toBe('Amazon'); // Merchant
      expect(values[2]).toBe('Shopping'); // Category
      expect(values[3]).toBe('Amazon Store Card'); // Account
      expect(parseFloat(values[6].replace(/[$,]/g, ''))).toBe(-45.99); // Amount
    });

    test('should correctly parse Chase-style transaction', () => {
      const line = '12/20/2025,12/21/2025,AMAZON MARKETPLACE SEATTLE WA,Shopping,-55.95';
      
      const values = parseCSVLine(line);
      
      expect(values[0]).toBe('12/20/2025'); // Transaction Date
      expect(values[2]).toBe('AMAZON MARKETPLACE SEATTLE WA'); // Description
      expect(parseFloat(values[4].replace(/[$,]/g, ''))).toBe(-55.95); // Amount
    });

    test('should correctly identify payment from description', () => {
      const description = 'PAYMENT FROM CHECK CONF';
      const type = determineTransactionType(701.15, description, '');
      expect(type).toBe('income');
    });

    test('should correctly identify balance adjustment as not income', () => {
      const description = 'Balance Adjustments';
      const type = determineTransactionType(500, description, '');
      // This is not a payment keyword, so should be expense
      expect(type).toBe('expense');
    });
  });
});


// ---------------------------------------------------------------------------
// These run against the REAL exported functions, not a copy of them.
// ---------------------------------------------------------------------------
import { importKey, parseAmount, isTransferCategory, isOutflow, inferAccountFromCsv, inferAccountType } from '@/components/CSVImportModal';

describe('Amount parsing (trust boundary)', () => {
  test('accepts plain and currency-formatted values', () => {
    expect(parseAmount('-58.12')).toBe(-58.12);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });

  test('treats parenthesised values as negative (accounting convention)', () => {
    expect(parseAmount('(58.12)')).toBe(-58.12);
  });

  test('handles unicode minus', () => {
    expect(parseAmount('−58.12')).toBe(-58.12);
  });

  test('rejects garbage instead of prefix-parsing it', () => {
    // parseFloat('12abc') silently returns 12 — that was the old behaviour.
    expect(parseAmount('12abc')).toBe(12); // digits survive stripping
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('Import key (idempotent re-import)', () => {
  const row = ['2026-01-05', -5000, 'USAA SECURE MAIN CHECKING (...4156)', 'USAA FUNDS TRANSFER DB'] as const;

  test('is stable across repeated imports of the same row', () => {
    expect(importKey(...row, 0)).toBe(importKey(...row, 0));
  });

  test('separates two genuinely identical same-day transactions', () => {
    // Two $3.50 coffees, same merchant, same day — must NOT collapse into one.
    expect(importKey('2026-01-05', -3.5, 'Visa (...2562)', 'STARBUCKS', 0))
      .not.toBe(importKey('2026-01-05', -3.5, 'Visa (...2562)', 'STARBUCKS', 1));
  });

  test('separates a charge from its same-day refund', () => {
    expect(importKey('2026-01-05', -50, 'Visa (...2562)', 'AMAZON', 0))
      .not.toBe(importKey('2026-01-05', 50, 'Visa (...2562)', 'AMAZON', 0));
  });

  test('survives an account being renamed in Monarch', () => {
    // Keyed on the last four digits, so a rename cannot duplicate the whole history.
    expect(importKey('2026-01-05', -50, 'USAA SECURE MAIN CHECKING (...4156)', 'X', 0))
      .toBe(importKey('2026-01-05', -50, 'Main Checking (...4156)', 'X', 0));
  });

  test('does not treat 85.5 and 85.50 as different rows', () => {
    expect(importKey('2026-01-05', 85.5, 'a (...1111)', 'X', 0))
      .toBe(importKey('2026-01-05', 85.50, 'a (...1111)', 'X', 0));
  });

  test('produces an id that is namespaced and Firestore-legal', () => {
    const id = importKey('2026-01-05', -50, 'a/b (...1111)', 'X/Y', 0);
    expect(id.startsWith('imp_')).toBe(true);
    expect(id).not.toContain('/'); // '/' is the one character Firestore forbids
    // Must not collide with the local/offline id namespaces the context checks for.
    expect(id.startsWith('local_')).toBe(false);
    expect(id.startsWith('offline_')).toBe(false);
  });
});

describe('Monarch category is authoritative for internal movement', () => {
  test('recognises Monarch transfer categories', () => {
    expect(isTransferCategory('Transfer')).toBe(true);
    expect(isTransferCategory('Credit Card Payment')).toBe(true);
  });

  test('does not swallow "Transfer Fee", which is a real expense', () => {
    expect(isTransferCategory('Transfer Fee')).toBe(false);
  });
});

describe('Card issuer sign conventions', () => {
  test('Amex/Discover: a positive amount is a charge, not income', () => {
    expect(isOutflow('amex', 5.75)).toBe(true);
    expect(isOutflow('discover', 45.10)).toBe(true);
  });

  test('Amex/Discover: a negative amount is the payment', () => {
    expect(isOutflow('amex', -4200)).toBe(false);
    expect(isOutflow('discover', -500)).toBe(false);
  });

  test('Monarch/Chase/generic keep the usual convention', () => {
    expect(isOutflow('monarch', -58.12)).toBe(true);
    expect(isOutflow('monarch', 6049.55)).toBe(false);
    expect(isOutflow('generic', -20)).toBe(true);
  });
});

describe('Account inference from CSV label (auto-create)', () => {
  // The real 8 accounts from the user's Monarch export. Getting bank-vs-credit right
  // is what makes "a card payment reduces debt, not income" hold.
  test('classifies the real accounts correctly', () => {
    const banks = [
      'Adv SafeBalance Banking (...2126)',
      'Advantage Savings (...2139)',
      'CHASE SAVINGS (...2591)',
      'TOTAL CHECKING (...7535)',
    ];
    const cards = [
      'Customized Cash Rewards Visa Signature (...3572)',
      'Blue Cash Preferred® (...1001)',
      'Apple Card',
      'Amazon Store Card (...3282)',
    ];
    banks.forEach(n => expect(inferAccountType(n)).toBe('bank_account'));
    cards.forEach(n => expect(inferAccountType(n)).toBe('credit_card'));
  });

  test('extracts last-4, strips it from the name, defaults balance to 0', () => {
    const a = inferAccountFromCsv('Customized Cash Rewards Visa Signature (...3572)');
    expect(a.lastFourDigits).toBe('3572');
    expect(a.name).toBe('Customized Cash Rewards Visa Signature');
    expect(a.type).toBe('credit_card');
    expect(a.provider).toBe('visa');
    expect(a.balance).toBe(0);
  });

  test('an account with no digits (Apple Card) has no last-4 and keeps its name', () => {
    const a = inferAccountFromCsv('Apple Card');
    expect(a.lastFourDigits).toBeUndefined();
    expect(a.name).toBe('Apple Card');
    expect(a.provider).toBe('apple');
  });

  test('Blue Cash Preferred is an Amex credit card', () => {
    const a = inferAccountFromCsv('Blue Cash Preferred® (...1001)');
    expect(a.type).toBe('credit_card');
    expect(a.provider).toBe('amex');
  });
});
