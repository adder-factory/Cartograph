CLASS zcl_cartograph_demo DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS greet IMPORTING iv_name TYPE string.
ENDCLASS.

CLASS zcl_cartograph_demo IMPLEMENTATION.
  METHOD greet.
    WRITE iv_name.
  ENDMETHOD.
ENDCLASS.
