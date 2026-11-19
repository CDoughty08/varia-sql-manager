SELECT 'single', "double", 'it\'s', "say \"hi\"", '';
SELECT r'raw \d+', R"raw", b'bytes', B"bytes", rb'\x00', BR"\n", br'x';
SELECT '''triple
single, with 'quotes' and \''' inside''', """triple
double""";
SELECT 42, -7, 3.14, .5, 1e10, 2.5E-3, 0x1F, 0XFF;
SELECT DATE '2026-11-18', TIMESTAMP '2026-11-18 09:30:00 UTC', NUMERIC '1.5', JSON '{"a": 1}';
SELECT TRUE, FALSE, NULL, 'unclosed
SELECT 'next line is code again';
