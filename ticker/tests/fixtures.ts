// Command output shaped like the real runs in the Q6 research, with neutral
// paths. Each is what the output file held at one moment.

const unitNames = [
  'parse_header', 'parse_body', 'parse_footer', 'load_config', 'save_config', 'merge_config',
  'resize_image', 'crop_image', 'rotate_image', 'hash_password', 'check_password', 'reset_token',
  'send_email', 'queue_email', 'retry_email', 'render_page', 'render_menu', 'render_footer',
  'cache_get', 'cache_set', 'cache_expire', 'sync_users', 'sync_groups', 'sync_roles',
  'export_csv', 'export_json', 'import_csv', 'import_json', 'search_index', 'search_query',
  'search_rank', 'billing_invoice', 'billing_refund', 'billing_tax', 'audit_log', 'audit_export',
]

/** Python unittest -v: the first `count` results, tests 08 and 33 failing. */
export function unittestOutput(count: number): string {
  return unitNames
    .slice(0, count)
    .map((name, i) => {
      const id = `test_${String(i).padStart(2, '0')}_${name}`
      return `${id} (test_suite.AppTests.${id}) ... ${i === 8 || i === 33 ? 'FAIL' : 'ok'}\n`
    })
    .join('')
}

export const unittestEnd = `
======================================================================
FAIL: test_08_rotate_image (test_suite.AppTests.test_08_rotate_image)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/work/tests/test_suite.py", line 30, in test_08_rotate_image
    self.assertEqual(round(0.1 + 0.2, 2), 0.31, 'rounding drift in rotate_image')
AssertionError: 0.3 != 0.31 : rounding drift in rotate_image

----------------------------------------------------------------------
Ran 36 tests in 90.112s

FAILED (failures=2)
`

/** A C build through make, `count` files compiled so far. */
export function makeOutput(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const name = i === 0 ? 'main' : `mod${String(i).padStart(2, '0')}`
    return `cc -O2 -Wall -c src/${name}.c -o obj/${name}.o\n`
  }).join('')
}

export const makeError = `${makeOutput(9)}src/mod08.c:1:50: error: invalid digit '8' in octal constant
    1 | int f08(int x){int s=0;for(int i=0;i<x;i++)s+=i*08;return s;}
      |                                                  ^
1 error generated.
make: *** [obj/mod08.o] Error 1
`

/** go test -v at about 40 s: TestRefunds failed, TestWebhooks running. */
export const goOutput = `=== RUN   TestCheckout
--- PASS: TestCheckout (4.00s)
=== RUN   TestCart
--- PASS: TestCart (4.00s)
=== RUN   TestInventory
--- PASS: TestInventory (4.00s)
=== RUN   TestPricing
--- PASS: TestPricing (4.00s)
=== RUN   TestDiscounts
--- PASS: TestDiscounts (4.00s)
=== RUN   TestShipping
--- PASS: TestShipping (4.00s)
=== RUN   TestTax
--- PASS: TestTax (4.00s)
=== RUN   TestRefunds
    shop_test.go:38: refund total = 9.99, want 10.00
--- FAIL: TestRefunds (4.00s)
=== RUN   TestPayments
--- PASS: TestPayments (4.00s)
=== RUN   TestWebhooks
`

/** npm install with verbose fetches: each package's details, then its archive. */
export function npmOutput(packages: readonly string[]): string {
  const details = packages.map(name => `npm http fetch GET 200 https://registry.npmjs.org/${name.replace('/', '%2f')} 24ms (cache miss)\n`)
  const archives = packages.map(name => `npm http fetch GET 200 https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-1.0.0.tgz 31ms (cache miss)\n`)
  return [...details, ...archives].join('')
}
