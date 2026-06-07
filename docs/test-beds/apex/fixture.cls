public with sharing class AccountService {
    @AuraEnabled(cacheable=true)
    public static List<Account> listAccounts() {
        List<Account> rows = new List<Account>();
        return rows;
    }
}
