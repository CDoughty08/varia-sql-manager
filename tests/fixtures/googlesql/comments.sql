-- a dash comment
# a hash comment
SELECT 1 -- trailing
  , 2 # trailing hash
  , 3 /* inline */ , 4;
/* a block
   comment over lines * and / alone
*/
SELECT '-- not a comment', "# not a comment either", '/* nor this */';
#legacySQL
