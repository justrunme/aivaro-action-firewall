-- Double every order quantity (no row or column removed).
UPDATE orders SET quantity = quantity * 2;
