# XM3YN@ E31A yellow-panel firmware fix

`ATC_Paper_XM3YN_E31A_stride_fix.bin` is built from commit
`9e378fee5a4ea02641a7844859f72b049df41313` of
`liuadou-ux/ATC_TLSR_Paper-stellar-XM3N`.

It contains one display-driver correction in
`Firmware/src/epd_bwr_266.c`, inside `EPD_BWR_266_Display_BWR`:

```diff
 EPD_WriteCmd(0x44);
 EPD_WriteData(0x00);
-EPD_WriteData(0x13);
+EPD_WriteData(0x12);
```

The controller X range is inclusive. A 152-pixel row contains 19 bytes,
so the valid byte addresses are 0 through 18 (`0x00..0x12`). The original
`0x13` range advances by 20 bytes per row while the BLE image planes contain
19 bytes per row, producing progressively shifted horizontal/diagonal strips.

- Target: XM3YN@ E31A yellow panel
- Panel: 296 × 152
- Size: 94,084 bytes
- SHA-256: `0EC27AC81694071B600218DE8445B7DCBBB6F3D1E1DBFAE4BE20F20DBA178B9D`

Do not flash this image to a different hardware model or panel variant.
